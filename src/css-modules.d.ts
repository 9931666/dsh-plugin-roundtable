/** Declares CSS Modules imports for the client TypeScript program. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
