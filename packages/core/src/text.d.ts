/** A Markdown file imported `with { type: 'text' }`: Bun inlines its contents at build time. */
declare module '*.md' {
  const text: string;
  export default text;
}
