// Tests never send production analytics. Telemetry tests inject their own relay.
process.env.BOITE_TELEMETRY_URL = '';
