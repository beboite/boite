/**
 * Whether the right panel's tab strip needs its scroll chevrons. The chevrons
 * sit beside the tabs, so while they show the tabs are `chevronRoom` narrower
 * than they would be without them. Measuring the narrowed box alone kept the
 * chevrons up at a width where every tab fits once they are gone.
 */
export function stripOverflows(scrollWidth: number, clientWidth: number, chevronRoom: number, showing: boolean): boolean {
  return scrollWidth - (clientWidth + (showing ? chevronRoom : 0)) > 1;
}
