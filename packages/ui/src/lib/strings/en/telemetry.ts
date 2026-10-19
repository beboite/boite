export const strings = {
  telemetry: {
    heading: 'Privacy and analytics',
    description: 'Basic counters are on by default. Enhanced analytics are optional. No messages, project names, paths, account details or recordings are collected.',
    basic: 'Anonymous counters',
    basicHint: 'Count active installations, launches, conversations and turn outcomes. Usage identifiers change daily; a separate identifier counts active installations only.',
    enhanced: 'Enhanced analytics',
    enhancedHint: 'Share selected public models, reasoning level, speed and permission modes, durations and token volumes with a stable random installation ID. Private models are grouped as other. Turning this off requests deletion of its profile and events.',
    unconfigured: 'This build has no analytics relay configured. Nothing is sent.',
    pending: 'Deletion is pending. Boite retries in the background. PostHog removes events asynchronously after accepting the request.',
    export: 'Export analytics data', retry: 'Retry deletion',
  }
} as const;
