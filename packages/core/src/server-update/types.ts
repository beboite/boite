export type UpdateCommand = (command: string, args: string[]) => Promise<string>;

export interface ServerInstallation {
  directory: string;
  executable: string;
  service: string;
}

/** Native service integration is supplied by ProcessPlatform; tests use an isolated service. */
export interface ServerUpdatePlatform {
  inspect(run: UpdateCommand): Promise<ServerInstallation | null>;
  launch(run: UpdateCommand, executable: string, plan: string): Promise<void>;
  control(service: string, action: 'start' | 'stop'): Promise<void>;
  mainPid(service: string): Promise<number>;
}

export interface ServerUpdatePlan {
  id: string;
  installation: ServerInstallation;
  dataDir: string;
  version: string;
  previousVersion: string;
  originalPid: number;
  healthUrl: string;
  archiveHash: string;
}
