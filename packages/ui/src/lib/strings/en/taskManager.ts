export const strings = {
  taskManager: {
    title: 'Task manager', scope: 'Live processes on this machine, grouped by agent.',
    agents: 'Agents', live: 'Updated every 2 seconds', paused: 'Updates paused', disconnected: 'Machine disconnected',
    loading: 'Reading agent usage', unsupported: 'Update Boite on this machine to see agent usage.',
    loadFailed: 'The task manager could not load. Try again.',
    search: 'Find an agent', noMatches: 'No matching agents.', sortBy: 'Sort by usage',
    sort: { memory: 'Most memory', cpu: 'Most CPU', disk: 'Most disk activity', network: 'Most network activity' },
    disk: 'Disk', network: 'Network', read: 'Read', write: 'Write', download: 'Download', upload: 'Upload',
    observed: 'Observed', unavailableHint: 'No measurement is available yet, or this counter is unsupported. A missing value does not mean zero usage.',
    partialHint: 'This total includes only agents with available measurements.',
    diskHint: 'Storage reads and writes observed while this view is open. Brief processes can be missed. This is activity, not folder size.',
    tcpHint: 'TCP downloads and uploads observed while this view is open. Brief connections and UDP traffic can be missed.',
    stop: 'Stop processes', stopConfirm: 'Stop every process in this conversation?', stopping: 'Stopping processes',
  }
} as const;
