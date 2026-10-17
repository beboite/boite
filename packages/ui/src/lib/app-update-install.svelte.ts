import { appUpdater, type AppUpdater } from './app-update.svelte';
import { confirm } from './confirm.svelte';
import { strings } from './strings';

/** One confirmation gate shared by every place that can start the installer. */
export class AppUpdateInstall {
  preparing = $state(false);

  /**
   * Asks once, then installs. A release still to download is downloaded
   * after the answer and installed as soon as it is verified: nothing
   * downloads before the user asked for it.
   */
  async request(updater: AppUpdater = appUpdater): Promise<boolean> {
    if (this.preparing || !(updater.ready || updater.snapshot.phase === 'available')) return false;
    const version = updater.snapshot.version;
    const channel = updater.snapshot.channel;
    this.preparing = true;
    try {
      const accepted = await confirm.ask({
        title: strings.appUpdate.installTitle,
        body: strings.appUpdate.installBody,
        confirmLabel: strings.appUpdate.install,
        cancelLabel: strings.common.cancel
      });
      if (!accepted) return false;
      if (updater.snapshot.version !== version || updater.snapshot.channel !== channel) return false;
      if (!(await updater.prepare())) return false;
      if (updater.snapshot.version !== version || updater.snapshot.channel !== channel) return false;
      updater.install();
      return true;
    } finally {
      this.preparing = false;
    }
  }
}

export const appUpdateInstall = new AppUpdateInstall();
