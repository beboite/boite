// Bun's compiled ESM entry must await the lazy graph before calling main.
const { main } = await import('./main.ts');
main(process.argv.slice(2));
export {};
