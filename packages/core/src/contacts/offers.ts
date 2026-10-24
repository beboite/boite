/** Advertise only projects explicitly granted to this contact, with their canonical endpoint. */
import type { Contact, ContactOffer } from '@boite/contracts';
import type { Core } from '../core.ts';
import { text } from '../coordination-letter.ts';
import { invalidParams, refused } from '../errors.ts';
import { projectRef } from './project-policy.ts';

export function contactOffers(core: Core, contact: Pick<Contact, 'grants'>): ContactOffer[] {
    return contact.grants.flatMap(grant => {
      if (grant.machine) return [{ projectId: grant.projectId, name: grant.name ?? grant.projectId, sharedProject: {ownerCoreId: core.coordination.card().coreId, coreId: grant.machine, projectId: grant.projectId} }];
      const project = core.journal.getProject(grant.projectId);
      return project && !project.archived ? [{ projectId: project.id, name: project.name.slice(0, 200), sharedProject: {ownerCoreId: core.coordination.card().coreId, coreId: core.coordination.card().coreId, projectId: project.id} }] : [];
    });
}

export function checkedContactOffers(coreId: string, payload: unknown): ContactOffer[] {
    const offers = (payload as { offers?: unknown } | null)?.offers;
    if (!Array.isArray(offers) || offers.length > 256) throw invalidParams('sync.offers: expected up to 256 projects');
    const checked: ContactOffer[] = offers.map((offer: Partial<ContactOffer>, index) => ({
      projectId: text(offer?.projectId, `sync.offers[${index}].projectId`, 128), name: text(offer?.name, `sync.offers[${index}].name`, 200),
      ...(offer?.sharedProject ? {sharedProject: projectRef(offer.sharedProject, 'sync.offer.sharedProject')} : {}),
    }));
    if (checked.some(o => o.sharedProject && (o.sharedProject.ownerCoreId !== coreId || o.sharedProject.projectId !== o.projectId))) throw refused('sync.offers: expected the contact owner and matching project id');
    return checked;
}
