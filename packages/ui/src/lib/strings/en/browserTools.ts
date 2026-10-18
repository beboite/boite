export const strings = {

  browserTools: {
    title: 'Browser testing tools', desktop: 'Desktop', laptop: 'Laptop', portrait: 'Portrait', landscape: 'Landscape',
    system: 'Follow system appearance', light: 'Light page', dark: 'Dark page', diagnostics: 'Page diagnostics and actions',
    startRecording: 'Record this browser tab', stopRecording: 'Stop recording', reviewRecording: 'Recorded video',
    clear: 'Clear', pageEvents: 'Page events', actions: 'Actions', noEvents: 'No page events captured.', noActions: 'No actions recorded yet.',
    omitted: '{count} older or oversized events omitted.', recorded: '{seconds} seconds · {fps} fps · {mb} MB · silent {format}',
    recordingError: 'Recording stopped after an error.', recordingLimit: 'Recording stopped by itself at the {mb} MB size limit. The video plays up to that point.',
    frameRate: 'Record at {rate} frames per second', codec: 'Encode as {codec}', codecUnavailable: 'This computer cannot encode it',
    unplayable: 'This view cannot play {codec} video. Download it to watch it in another player.',
    download: 'Download video', discard: 'Discard video',
  }
} as const;
