export const strings = {
  coordination: {
    options: 'Advanced settings',
    heading: 'Communication between conversations', off: 'Off', on: 'On',
    summaryOff: 'Other agents cannot find, read or contact this thread.',
    summaryOn: 'Other agents here and on linked machines can find this thread, read its conversation and message it.',
    ownerOnly: 'Only the owner can change coordination. This device can inspect the directory and exchanges.',
    resources: 'Resources and responsibilities', resourcesPlaceholder: 'What this agent owns, can answer, or should avoid',
    remote: 'Across projects and machines', remoteHint: 'Let agents in other projects and on linked machines find this thread, read its conversation and message it. Both threads must enable this.',
    pause: 'Pause coordination', resume: 'Resume coordination', paused: 'Paused',
    sends: '{used} of {limit} sends this hour', wakes: '{used} of {limit} wake turns this hour', receives: 'Recipients accept up to {limit} letters each hour.',
    sent: '{used} sent this hour', woken: '{used} wake turns this hour',
    directory: 'Authorized contacts', directoryEmpty: 'No opted-in thread in this project is available.', unavailable: 'Unavailable contacts',
    details: 'Show exchange',
    machineNotConnected: 'Connect to this machine in Settings to open its thread.',
    status: {
      queued: 'Queued in the outbox', received: 'Received by the recipient core', delivered: 'Submitted to the recipient agent',
      uncertain: 'Submission outcome uncertain. Boite will not replay it.', expired: 'Expired', rejected: 'Rejected'
    },
    bubbleStatus: {
      queued: 'Waiting', received: 'Waiting', delivered: 'Sent', uncertain: 'Unconfirmed', expired: 'Expired', rejected: 'Failed'
    }
  }
} as const;
