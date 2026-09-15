const response = await fetch('http://127.0.0.1:7337/health', {
  signal: AbortSignal.timeout(4000),
});
if (!response.ok) throw new Error(`core health returned ${response.status}`);
const health = await response.json();
if (health === null || typeof health !== 'object' || health.ok !== true) {
  throw new Error('invalid core health response');
}
