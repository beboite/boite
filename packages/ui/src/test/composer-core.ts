import { vi } from 'vitest';
import { FakeComposerState } from '../lib/fake-client/composer';
import type { FakeContext, FakeMethods } from '../lib/fake-client/context';

/** Observe or hold the core's internal delivery, independently of transport RPCs. */
export class TestComposerCore extends FakeComposerState {
  readonly start = vi.fn<FakeMethods['turns.start']>();
  readonly steer = vi.fn<FakeMethods['turns.steer']>();
  readonly activity = vi.fn<FakeMethods['threads.activity.set']>();

  override attach(ctx: FakeContext, methods: () => FakeMethods): void {
    this.start.mockImplementation(params => methods()['turns.start'](params));
    this.steer.mockImplementation(params => methods()['turns.steer'](params));
    this.activity.mockImplementation(params => methods()['threads.activity.set'](params));
    super.attach(ctx, () => ({ ...methods(), 'turns.start': this.start, 'turns.steer': this.steer, 'threads.activity.set': this.activity }));
  }
}
