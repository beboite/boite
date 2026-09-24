interface LabModel {
  readonly processKey: string;
  readonly isUsable: boolean;
  initialize(): Promise<unknown>;
  close(): Promise<unknown>;
}

/** Failed turns invalidate the transport. Keep replacement ownership before
 * initialization so a setup error cannot hide the new process from cleanup.
 */
export async function recoverLabModel<T extends LabModel>(state: { current: T; groups: string[] }, create: () => T) {
  if (state.current.isUsable) return;
  await state.current.close();
  state.current = create();
  state.groups.push(state.current.processKey);
  await state.current.initialize();
}
