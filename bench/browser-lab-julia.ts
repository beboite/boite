import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { BrowserLabCodex, type BrowserContentItem } from './browser-lab-codex.ts';
import { createBrowserLabEngine, type BrowserLabEngine } from './browser-lab-engine.ts';
import { createLabContext } from './browser-lab-isolation.ts';
import { LabPage, labTool } from './browser-lab-page.ts';
import { labTasks } from './browser-lab-tasks.ts';
import { recoverLabModel } from './browser-lab-model.ts';
import { useDirectCapture } from './browser-lab-capture.ts';
import { useNativeDownload } from './browser-lab-download.ts';
import { BrowserLabRecording } from './browser-lab-recording.ts';
import { assessInitialNavigation, candidatePlannerInstruction, counterbalancedModes, parseCandidateDecision, parseJuliaResult, permuteCandidateDecision, prepareJuliaChoice, rememberObservedUrls } from './browser-lab-julia-choice.ts';

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const clean = (_key: string, value: unknown) => typeof value === 'string' && value.startsWith('data:image/')
  ? { omittedImage: true, length: value.length, sha256: createHash('sha256').update(value).digest('hex') } : value;
const save = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, clean, 2));

function choiceTool() {
  const commands = (labTool(true).inputSchema.properties.commands.items);
  return { type: 'function', name: 'choose_action', description: 'Propose grounded single-action candidates. The benchmark chooses and executes one; the next message supplies its index, result and fresh browser observation/screenshot. Do not execute actions yourself. Call again after every observation. Finish by including a finish candidate with grounded facts.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['subgoal', 'memory', 'candidates', 'preferredIndex'], properties: {
      subgoal: { type: 'string', minLength: 1, maxLength: 1500 }, memory: { type: 'string', maxLength: 6000 },
      candidates: { type: 'array', minItems: 2, maxItems: 12, items: { type: 'object', additionalProperties: false,
        required: ['description', 'command'], properties: { description: { type: 'string', minLength: 1, maxLength: 140 }, command: commands } } },
      preferredIndex: { type: 'integer', minimum: 0, maximum: 11 },
    } } };
}

async function predictJulia(endpoint: URL, token: string | undefined, prepared: ReturnType<typeof prepareJuliaChoice>, backend: string, signal: AbortSignal, remainingMs: number) {
  const started = performance.now();
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ ...prepared.payload, backend }), signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.floor(remainingMs)))]) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Julia HTTP ${response.status}; inference rejected, no model fallback or input truncation.`);
  }
  const value = await response.json();
  return { ...parseJuliaResult(value, prepared.payload.rows[0]!.options.length), requestMs: performance.now() - started };
}

async function main() {
  if (process.env.BOITE_BENCH_JULIA !== '1') throw new Error('Set BOITE_BENCH_JULIA=1 for the live candidate-selector experiment.');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, codex = process.env.BOITE_BENCH_CODEX_BINARY;
  if (!binary || !codex || !process.env.BOITE_BENCH_OUTPUT) throw new Error('Browser/Codex binaries and fresh BOITE_BENCH_OUTPUT are required.');
  const output = resolve(process.env.BOITE_BENCH_OUTPUT);
  if (existsSync(output)) throw new Error('BOITE_BENCH_OUTPUT: expected a fresh directory.');
  const modes = process.env.BOITE_BENCH_JULIA_MODES?.split(',') ?? ['candidate-model', 'candidate-julia'];
  if (!modes.length || new Set(modes).size !== modes.length || modes.some(mode => !['candidate-model', 'candidate-julia'].includes(mode))) throw new Error('BOITE_BENCH_JULIA_MODES: expected candidate-model and/or candidate-julia, without duplicates.');
  const tasks = process.env.BOITE_BENCH_TASKS ? process.env.BOITE_BENCH_TASKS.split(',').map(id => {
    const task = labTasks.find(task => task.id === id); if (!task) throw new Error('Unknown task: ' + id); return task;
  }) : labTasks;
  const timeoutMs = Number(process.env.BOITE_BENCH_TIMEOUT_MS ?? 180000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000) throw new Error('BOITE_BENCH_TIMEOUT_MS: expected 30000 to 600000.');
  const recorded = process.env.BOITE_BENCH_RECORD === '1';
  const backend = process.env.BOITE_JULIA_BACKEND ?? 'torch';
  if (!['torch', 'onnx'].includes(backend)) throw new Error('BOITE_JULIA_BACKEND: expected torch or onnx.');
  if (recorded && !process.env.BOITE_BENCH_FFMPEG) throw new Error('BOITE_BENCH_RECORD=1 requires BOITE_BENCH_FFMPEG.');
  const endpoint = new URL('/predict', process.env.BOITE_JULIA_URL ?? 'http://127.0.0.1:18884');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('BOITE_JULIA_URL: expected an owned HTTP loopback endpoint with no URL credentials.');
  mkdirSync(output, { recursive: true });
  const workspace = join(output, 'workspace'); mkdirSync(workspace);
  const sources = ['browser-lab-julia.ts', 'browser-lab-julia-choice.ts', 'browser-lab-julia-choice.test.ts', 'browser-lab-page.ts',
    'browser-lab-tasks.ts', 'browser-lab-codex.ts', 'browser-lab-engine.ts', 'browser-lab-native.ts', 'browser-lab-isolation.ts',
    'browser-lab-model.ts', 'browser-lab-capture.ts', 'browser-lab-download.ts', 'browser-lab-recording.ts'];
  const executablePath = findBrowser();
  const protocol = { date: new Date().toISOString(), tasks, modes, repetitions: 1, timeoutMs, maxActions: 60, maxDecisions: 80,
    trialOrder: tasks.map(task => ({ task: task.id, taskOffset: labTasks.indexOf(task), modes: counterbalancedModes(modes, labTasks.indexOf(task)) })),
    armOrder: 'Configured order on even frozen-task offsets; reversed on odd offsets, including task subsets.',
    recorded, recordingTiming: recorded ? 'Instrumented CDP screencast run; analyze separately from unrecorded timing. Recording starts after the initial real observation and before any planner action. Recorder startup is included in executionMs and saved separately.' : 'Unrecorded timing run.',
    ffmpegBinaryHash: recorded ? sha(process.env.BOITE_BENCH_FFMPEG!) : undefined,
    initialNavigationRecovery: 'No retry. After an initial navigate error, save actual URL/readiness/title/full body text and capture. Continue only at the exact requested URL, interactive/complete readiness, body text longer than 50 characters and no browser-error title.',
    planner: { model: 'gpt-6-luna', effort: 'max', tier: 'priority', tools: ['choose_action'], conversation: 'One fresh ephemeral task thread per trial, kept throughout the task. Same candidate generation prompt and preferredIndex field in both arms.' },
    selector: { modelArm: 'Planner preferredIndex', juliaArm: 'Julia-1 /predict choice index, no fallback. Planner provides subgoal and 2 to 12 grounded candidates; this is not autonomous Julia.',
      permutation: 'Fisher-Yates with deterministic FNV-1a seeded Mulberry32; seed task.id + colon + step, identical across arms, independent of preferredIndex. Preferred and selected indices remapped.' },
    proposalRecovery: 'Invalid candidate proposals execute no action. Return the validation error and unchanged observation for at most two consecutive corrections. Corrections consume the same deadline and decision budget in both arms. Selector errors remain fatal, with no fallback.',
    grounding: 'Refs and tabs must be current. Exact URLs from any observation delivered during this trial remain available; task domains and HTTPS are enforced. Raw hidden evidence never extends this URL inventory.',
    julia: { endpoint: endpoint.href, backend, maxLength: 8192, tokenConfigured: !!process.env.BOITE_JULIA_TOKEN, screenshot: false,
      input: 'Task goal, full subgoal/memory and current scoped LabPage text state. The question repeats the planner immediate subgoal explicitly. Neutral candidate descriptions have at most 140 characters. No preferredIndex or command objects.' },
    context: 'Identical planner observation and full conversation policy for both arms; replacement memory limited to 6000 characters. Selector state uses all candidate target snapshot lines plus one neighbor on each side, up to 7000 characters with overflow rejection; up to 1000 characters of other snapshot lines, 1600 page-text characters and 1600 dialog characters. Tabs retained, links restricted to candidate URLs. Every omission counted. Both arms prepare and log identical policy; raw evidence retained.',
    independentReviewRequired: true, grading: 'No model claim or finish flag is scored as success. Saved observations, screenshots, action log, download artifact and task rubric require independent review.',
    directCapture: true, nativeDownloadCorrection: true, engine: 'agent-browser', isolatedContext: true,
    viewport: { width: 1280, height: 800 }, colorScheme: 'light', browserBinary: executablePath,
    binaryHash: sha(binary), browserBinaryHash: sha(executablePath), codexBinaryHash: sha(codex),
    sourceHashes: Object.fromEntries(sources.map(file => [file, sha(join(import.meta.dir, file))])) };
  save(join(output, 'protocol.json'), protocol);
  if (modes.includes('candidate-julia')) {
    const health = await fetch(new URL('/health', endpoint), { redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: process.env.BOITE_JULIA_TOKEN ? { Authorization: `Bearer ${process.env.BOITE_JULIA_TOKEN}` } : {} });
    if (!health.ok) throw new Error(`Julia health HTTP ${health.status}; no trials started.`);
    const runtime = await health.json();
    if (runtime?.ready !== true || !runtime.metadata || typeof runtime.metadata !== 'object') throw new Error('Julia health: expected ready=true and runtime metadata.');
    save(join(output, 'julia-runtime.json'), runtime);
  }
  mkdirSync(join(output, 'source')); for (const file of sources) writeFileSync(join(output, 'source', file), readFileSync(join(import.meta.dir, file)));
  const harness = await startTestCore();
  let context: ReturnType<typeof createLabContext> | undefined;
  let models: { current: BrowserLabCodex; groups: string[] } | undefined;
  const summaries: unknown[] = [], browserGroups: string[] = [];
  const cancellation = new AbortController(); let stopReason: string | undefined;
  const stop = (reason: string) => { stopReason ??= reason; cancellation.abort(); void models?.current.close().catch(() => {}); };
  const interrupt = () => stop('signal'); process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const watcher = setInterval(() => { if (existsSync(join(output, 'stop.requested'))) stop('stop.requested'); }, 500); watcher.unref();
  try {
    context = createLabContext(harness.core, output, true);
    const createModel = () => new BrowserLabCodex(context!.core, codex, workspace, { model: protocol.planner.model });
    const firstModel = createModel(); models = { current: firstModel, groups: [firstModel.processKey] };
    save(join(output, 'model.json'), await firstModel.initialize());
    for (const task of tasks) for (const mode of counterbalancedModes(modes, labTasks.indexOf(task))) {
      if (stopReason) break;
      const id = `${mode}-${task.id}-1`, directory = join(output, id); mkdirSync(directory);
      const started = performance.now(), logs: unknown[] = [];
      const sample: any = { id, mode, task: task.id, run: 1, startedAt: new Date().toISOString(), rubric: task.rubric,
        gradingStatus: 'awaiting-independent-review', decisions: [] };
      let engine: BrowserLabEngine | undefined, page: LabPage | undefined, recording: BrowserLabRecording | undefined;
      try {
        await recoverLabModel(models, createModel);
        browserGroups.push(`browser:${id}`);
        engine = await createBrowserLabEngine('agent-browser', { core: harness.core, taskId: id, binary, executablePath,
          signal: cancellation.signal, log: entry => logs.push(entry) });
        await useDirectCapture(engine, entry => logs.push(entry));
        useNativeDownload(engine, entry => logs.push(entry));
        save(join(directory, 'owned-processes.json'), harness.core.procs.liveOf(engine.processGroup)); sample.engine = engine.metadata;
        await engine.command('viewport', protocol.viewport);
        try { await engine.command('navigate', { url: task.url, waitUntil: 'domcontentloaded' }); }
        catch (error) {
          sample.initialNavigationError = error instanceof Error ? error.stack ?? String(error) : String(error);
          const diagnostic: any = { requestedUrl: task.url, error: sample.initialNavigationError };
          try {
            diagnostic.state = (await engine.command('evaluate', { script: '({url:location.href,readyState:document.readyState,title:document.title,bodyText:document.body?.innerText??""})' })).result;
            diagnostic.assessment = assessInitialNavigation(task.url, diagnostic.state);
          } catch (diagnosticError) {
            diagnostic.diagnosticError = String(diagnosticError);
            diagnostic.assessment = { accepted: false, reasons: ['Could not read current document state.'] };
          }
          try {
            await engine.command('prepare_observation');
            diagnostic.capture = join(directory, 'initial-navigation.png');
            await engine.command('screenshot', { path: diagnostic.capture });
          } catch (captureError) { diagnostic.captureError = String(captureError); }
          sample.initialNavigationDiagnostic = diagnostic;
          save(join(directory, 'initial-navigation.json'), diagnostic);
          if (!diagnostic.assessment.accepted) throw new Error('Initial navigation diagnostic rejected recovery: ' + diagnostic.assessment.reasons.join(' ') + ' Original error: ' + sample.initialNavigationError);
        }
        sample.startupMs = performance.now() - started;
        const executionStarted = performance.now(), deadline = executionStarted + timeoutMs;
        page = new LabPage(engine, task, true, directory, deadline, protocol.maxActions);
        const first = await page.observe();
        if (recorded) {
          browserGroups.push(`${engine.processGroup}:video`);
          const recordingStarted = performance.now();
          recording = await BrowserLabRecording.start(engine, { core: harness.core, output: join(directory, 'recording.mp4'), ffmpegPath: process.env.BOITE_BENCH_FFMPEG!, fps: 10 });
          sample.recordingStartupMs = performance.now() - recordingStarted;
        }
        let observation = first.text, imageUrl = first.imageUrl, memory = '', lastDeliveryMs = performance.now(), decisions = 0, proposalErrors = 0;
        const knownUrls = new Set<string>();
        rememberObservedUrls(observation, knownUrls);
        const promptStarted = performance.now();
        const input: BrowserContentItem[] = [{ type: 'inputText', text: candidatePlannerInstruction + '\nTask:\n' + task.goal
          + '\nCurrent observation:\n' + JSON.stringify(observation) }];
        if (imageUrl) input.push({ type: 'inputImage', imageUrl });
        sample.promptPreparationMs = performance.now() - promptStarted;
        sample.initialPromptCharacters = input[0]!.type === 'inputText' ? input[0]!.text.length : 0;
        sample.model = await models.current.run(input, [choiceTool()], async (name, args) => {
          const arrived = performance.now(), step = ++decisions;
          const record: any = { step, candidateGenerationMs: arrived - lastDeliveryMs, currentObservationId: page!.history.at(-1)?.id,
            observationCharacters: JSON.stringify(observation).length, priorMemoryCharacters: memory.length,
            rawEvidenceCharacters: { snapshot: String(page!.history.at(-1)?.snapshot.snapshot ?? '').length,
              pageText: String(page!.history.at(-1)?.state.text ?? '').length,
              links: page!.history.at(-1)?.state.links?.length ?? 0 } };
          sample.decisions.push(record);
          const decisionFile = join(directory, `decision-${String(step).padStart(2, '0')}.json`);
          try {
            if (name !== 'choose_action') throw new Error(`Unexpected planner tool: ${name}; expected choose_action.`);
            cancellation.signal.throwIfAborted();
            if (sample.decisionError) throw new Error('Earlier candidate/selector failure ended this trial.');
            if (page!.finished) throw new Error('Task already finished; no more decisions permitted.');
            if (step > protocol.maxDecisions || performance.now() >= deadline) throw new Error('Decision budget or deadline exhausted.');
            record.proposal = args;
            let originalDecision;
            try {
              originalDecision = parseCandidateDecision(JSON.stringify(args), observation, !!imageUrl, task.hosts, knownUrls);
              proposalErrors = 0;
            } catch (error) {
              record.validationError = String(error);
              record.consecutiveProposalErrors = ++proposalErrors;
              if (proposalErrors > 2) throw error;
              record.correctionRequested = true;
              return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({
                candidateValidationError: record.validationError, actionExecuted: false,
                instruction: 'Correct the candidate proposal using this unchanged current observation. Every command must be distinct and grounded.',
                ...observation,
              }) }, ...(imageUrl ? [{ type: 'inputImage' as const, imageUrl }] : [])] };
            }
            const permutationSeed = `${task.id}:${step}`;
            const { decision, originalIndices } = permuteCandidateDecision(originalDecision, permutationSeed);
            const prepared = prepareJuliaChoice(task.goal, observation, decision);
            Object.assign(record, { subgoal: decision.subgoal, memory: decision.memory, candidates: decision.candidates,
              preferredIndex: decision.preferredIndex, originalPreferredIndex: originalDecision.preferredIndex,
              permutationSeed, originalIndices, preparedLengths: prepared.lengths });
            // Prepared payload is saved separately for an audit of selector input.
            save(join(directory, `selector-input-${String(step).padStart(2, '0')}.json`), { ...prepared.payload, backend });
            let chosenIndex = decision.preferredIndex;
            const selectionStarted = performance.now();
            if (mode === 'candidate-julia') {
              record.julia = await predictJulia(endpoint, process.env.BOITE_JULIA_TOKEN, prepared, backend, cancellation.signal, deadline - performance.now());
              chosenIndex = record.julia.index;
            }
            Object.assign(record, { chosenIndex, originalChosenIndex: originalIndices[chosenIndex], selectionMs: performance.now() - selectionStarted,
              chosenCommand: decision.candidates[chosenIndex]!.command });
            if (page!.actionCount >= protocol.maxActions && !['observe', 'finish'].includes(record.chosenCommand.action)) throw new Error('Action budget exhausted.');
            memory = decision.memory;
            const actionStarted = performance.now();
            const result = await page!.execute({ commands: [decision.candidates[chosenIndex]!.command] });
            record.actionAndObservationMs = performance.now() - actionStarted;
            observation = JSON.parse(result.contentItems.find(item => item.type === 'inputText')!.text!);
            rememberObservedUrls(observation, knownUrls);
            imageUrl = result.contentItems.find(item => item.type === 'inputImage')?.imageUrl;
            save(join(output, 'progress.json'), { id, step, seconds: Math.round((performance.now() - executionStarted) / 1000), actions: page!.actionCount });
            return { contentItems: [{ type: 'inputText', text: JSON.stringify({ selectedIndex: originalIndices[chosenIndex], memory, ...observation }) },
              ...(imageUrl ? [{ type: 'inputImage' as const, imageUrl }] : [])], success: true };
          } catch (error) {
            record.error = error instanceof Error ? error.stack ?? String(error) : String(error);
            record.inferenceError = mode === 'candidate-julia' && record.preparedLengths && record.chosenIndex === undefined ? record.error : undefined;
            record.inputOverflow = /overflow|truncat|8192|413|422/.test(String(error));
            // Fail the entire trial instead of silently replacing a selector or reusing stale state.
            sample.decisionError = record.error;
            // BrowserLabCodex reports tool exceptions to its planner. Close the
            // owned model transport so it cannot retry after an inference error.
            void models!.current.close().catch(closeError => { sample.modelCleanupError = String(closeError); });
            throw error;
          } finally {
            record.handlerMs = performance.now() - arrived;
            lastDeliveryMs = performance.now(); save(decisionFile, record);
          }
        }, deadline - performance.now());
        sample.executionMs = performance.now() - executionStarted;
        sample.totalMs = performance.now() - started;
        if (!page.finished) sample.stopReason = stopReason ?? (performance.now() >= deadline ? 'deadline' : 'planner-ended-without-finish');
      } catch (error) { sample.error = error instanceof Error ? error.stack : String(error); }
      finally {
        if (stopReason) sample.cancelled = stopReason;
        sample.elapsedBeforeCleanupMs = performance.now() - started;
        sample.answer = page?.answer; sample.finished = page?.finished ?? false; sample.actions = page?.actionCount ?? 0;
        sample.attempts = page?.attempts ?? []; sample.visited = page?.visited ?? [];
        sample.observations = page?.history.map(item => ({ id: item.id, url: item.state.url, title: item.state.title, errors: item.errors, observationMs: item.observationMs })) ?? [];
        const file = join(directory, 'download.zip'); if (existsSync(file)) sample.download = { bytes: statSync(file).size, headerHex: readFileSync(file).subarray(0, 4).toString('hex'), sha256: sha(file) };
        try { sample.recording = await recording?.stop(); } catch (error) { sample.recordingError = String(error); }
        try { await engine?.close(); } catch (error) { sample.cleanupError = String(error); }
        sample.processesAfter = harness.core.procs.liveCount(`browser:${id}`);
        save(join(directory, 'commands.json'), logs); save(join(directory, 'result.json'), sample);
        const summary = { id, totalMs: sample.totalMs, finished: sample.finished, gradingStatus: sample.gradingStatus,
          actions: sample.actions, decisions: sample.decisions.length, answer: sample.answer, error: sample.error ?? sample.decisionError,
          processesAfter: sample.processesAfter };
        summaries.push(summary); save(join(output, 'summary.json'), summaries); console.log(JSON.stringify(summary));
      }
    }
  } finally {
    clearInterval(watcher); process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    try { await models?.current.close(); }
    finally {
      try { await harness.stop(); }
      finally {
        try { context?.close(); }
        finally { save(join(output, 'cleanup.json'), { stopReason, completedTrials: summaries.length,
          modelGroups: models?.groups.map(group => ({ group, remaining: harness.core.procs.liveCount(group) })) ?? [],
          browserGroups: browserGroups.map(group => ({ group, remaining: harness.core.procs.liveCount(group) })) }); }
      }
    }
  }
}
if (import.meta.main) await main();
