export const strings = {

  experiments: {
    recordingIndicators: { title: 'Show actions in recordings', hint: 'Add click markers and navigation keys to browser recordings. Typed text and password input are never shown as key labels.' },
    openChatLinks: { title: 'Open chat links in their apps', hint: 'On this desktop, clicking a local file or folder opens its default app, including shortcuts and files outside the project. Only links from this computer are opened.' },
    whip: {
      title: 'Whip',
      hint: 'An animated whip follows your pointer or finger. Flick to crack it, click or tap to drop it',
      action: 'Throw the whip',
      drop: 'Drop the whip'
    },
    previewComments: { title: 'Preview comments', hint: 'Select an element in the integrated browser and add feedback to the conversation draft' },
    goal2: {
      title: 'Reviewed goals',
      hint: 'Adds /goal2: another model writes the checklist of everything you asked for, updates it when you add or change something and, after each turn of the agent, tells it what is still open. When the agent says the goal is done, a new conversation that has not seen its work checks it and answers pass, partial or fail. Anything but a pass goes back to the agent, for up to five reviews',
      trackerModel: 'Checklist model',
      trackerModelHint: 'Writes the checklist from your messages and checks it after every turn of the agent, on this machine. Automatic picks Opus at medium or Sol at high, the conversation\'s own agent first, else the conversation\'s model. A small model drops and inverts requests on long prompts.',
      trackerAuto: 'Automatic',
      trackerAutoHint: 'Opus medium or Sol high',
      trackerEffort: 'Reasoning of the checklist model',
      trackerEffortDefault: 'Default'
    },
    themeGrain: {
      title: 'Grain theme',
      hint: 'A grainy ground fading from light grey at the top left to black at the bottom right'
    },
    sessionImport: {
      title: 'Claude Code session import',
      hint: 'Turn a session started in the terminal into a thread, from the project menu and the palette'
    },
    promptCache: {
      title: 'Prompt cache timer',
      hint: 'A clock beside the context meter counting down how long the provider keeps the conversation cached'
    },
    residentAgents: {
      title: 'Agents',
      hint: 'Resident agents with their own brain, missions and routines, from the sidebar. Agents you already made keep running while this is off'
    },
    edgeScrollbars: {
      title: 'Edge scrollbars',
      hint: 'Scrollbars take no room. Each one fades in as the pointer nears the edge of its area and can still be dragged. Mouse and pen only'
    },
    pressPreload: {
      title: 'Load on press',
      hint: 'A thread or page starts loading when you press it, before you release the click or lift your finger'
    },
    contacts: {
      title: 'Contacts',
      hint: 'A Home page beside Threads where you link your Boite with another owner\'s through Tailscale, so your agents and theirs work together on the projects each side opens. Not ready for everyday use'
    }
  }
} as const;
