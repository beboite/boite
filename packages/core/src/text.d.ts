/** A Markdown file imported `with { type: 'text' }`: Bun inlines its contents at build time. */
declare module '*.md' {
  const text: string;
  export default text;
}

/** A file imported `with { type: 'file' }`: Bun copies it beside the bundle, or into a compiled executable, and gives its path. */
declare module '*.jar' {
  const path: string;
  export default path;
}
