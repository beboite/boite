import type { Translation } from '../../i18n.svelte';

export const fr: Translation = {
  updateAll: {
    heading: 'Mises à jour',
    trigger: 'Mises à jour disponibles',
    busy: 'Mise à jour en cours',
    run: 'Tout mettre à jour',
    app: "Mettre à jour l'app",
    retry: 'Réessayer',
    later: 'Me le rappeler plus tard',
    restarts: 'Boite télécharge sa version, puis demande à redémarrer. Les conversations reprennent où elles en étaient.',
    summary: (count: number) => count === 1 ? '1 mise à jour' : `${count} mises à jour`,
    downloading: (percent: number | null) => percent === null ? 'Téléchargement' : `Téléchargement ${percent} %`,
    ready: 'Redémarre pour finir',
    restartsNext: 'Redémarre une fois les agents à jour',
    waiting: 'Attend la fin du travail',
    installing: 'Redémarrage',
    updating: 'Mise à jour',
    waitingFor: (count: number) => count === 1 ? "Attend la pause d'une conversation" : `Attend la pause de ${count} conversations`,
    failed: 'Échec',
    done: 'À jour',
    allDone: 'Tout est à jour',
    finish: 'Boite est prête : redémarre pour finir.',
    restart: 'Redémarrer'
  }
};
