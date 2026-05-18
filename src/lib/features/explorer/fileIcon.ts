import {
  siTypescript,
  siJavascript,
  siSvelte,
  siVuedotjs,
  siAstro,
  siReact,
  siRust,
  siGo,
  siPython,
  siRuby,
  siPhp,
  siKotlin,
  siSwift,
  siDart,
  siCplusplus,
  siC,
  siHtml5,
  siCss,
  siSass,
  siLess,
  siTailwindcss,
  siJson,
  siYaml,
  siToml,
  siMarkdown,
  siGnubash,
  siDocker,
  siGit,
  siGithubactions,
  siNpm,
  siPnpm,
  siBun,
  siNodedotjs,
  siSqlite,
  siGraphql,
  siVite,
  siEslint,
  siPrettier,
  siTauri,
  siGitlab,
} from "simple-icons";

export type FileGlyphCategory =
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "lock"
  | "spreadsheet"
  | "doc"
  | "code"
  | "text"
  | "binary";

export interface BrandFileGlyph {
  kind: "brand";
  path: string;
  hex: string;
}

export interface CategoryFileGlyph {
  kind: "category";
  category: FileGlyphCategory;
}

export type FileGlyph = BrandFileGlyph | CategoryFileGlyph;

interface SimpleIcon {
  path: string;
  hex: string;
}

function brand(icon: SimpleIcon, hexOverride?: string): BrandFileGlyph {
  return { kind: "brand", path: icon.path, hex: hexOverride ?? icon.hex };
}

const TS_BRAND = brand(siTypescript);
const JS_BRAND = brand(siJavascript);
const NPM_BRAND = brand(siNpm);
const JSON_BRAND = brand(siJson, "cbcb41");
const MD_BRAND = brand(siMarkdown, "9aa4b3");
const RUST_BRAND = brand(siRust, "ce422b");
const GIT_BRAND = brand(siGit);
const DOCKER_BRAND = brand(siDocker);
const TAURI_BRAND = brand(siTauri, "ffc131");
const SVELTE_BRAND = brand(siSvelte);

const BY_FILENAME: Record<string, BrandFileGlyph> = {
  "package.json": NPM_BRAND,
  "package-lock.json": NPM_BRAND,
  ".npmrc": NPM_BRAND,
  "pnpm-lock.yaml": brand(siPnpm),
  "pnpm-workspace.yaml": brand(siPnpm),
  "bun.lockb": brand(siBun),
  "bun.lock": brand(siBun),
  "bunfig.toml": brand(siBun),
  dockerfile: DOCKER_BRAND,
  "docker-compose.yml": DOCKER_BRAND,
  "docker-compose.yaml": DOCKER_BRAND,
  ".dockerignore": DOCKER_BRAND,
  ".gitignore": GIT_BRAND,
  ".gitattributes": GIT_BRAND,
  ".gitmodules": GIT_BRAND,
  ".gitconfig": GIT_BRAND,
  ".gitlab-ci.yml": brand(siGitlab),
  "tauri.conf.json": TAURI_BRAND,
  "tauri.conf.json5": TAURI_BRAND,
  "cargo.toml": RUST_BRAND,
  "cargo.lock": RUST_BRAND,
  "rust-toolchain.toml": RUST_BRAND,
  "rustfmt.toml": RUST_BRAND,
  "clippy.toml": RUST_BRAND,
  "tsconfig.json": TS_BRAND,
  "tsconfig.node.json": TS_BRAND,
  "tsconfig.app.json": TS_BRAND,
  "tsconfig.build.json": TS_BRAND,
  "svelte.config.js": SVELTE_BRAND,
  "svelte.config.ts": SVELTE_BRAND,
  "tailwind.config.js": brand(siTailwindcss),
  "tailwind.config.ts": brand(siTailwindcss),
  "postcss.config.js": brand(siCss, "1572b6"),
  "vite.config.js": brand(siVite),
  "vite.config.ts": brand(siVite),
  "vitest.config.js": brand(siVite),
  "vitest.config.ts": brand(siVite),
  ".eslintrc": brand(siEslint),
  ".eslintrc.js": brand(siEslint),
  ".eslintrc.json": brand(siEslint),
  ".eslintrc.cjs": brand(siEslint),
  "eslint.config.js": brand(siEslint),
  "eslint.config.mjs": brand(siEslint),
  ".prettierrc": brand(siPrettier),
  ".prettierrc.json": brand(siPrettier),
  ".prettierrc.js": brand(siPrettier),
  "prettier.config.js": brand(siPrettier),
  ".prettierignore": brand(siPrettier),
  ".node-version": brand(siNodedotjs),
  ".nvmrc": brand(siNodedotjs),
};

const BY_EXT: Record<string, FileGlyph> = {
  ts: TS_BRAND,
  mts: TS_BRAND,
  cts: TS_BRAND,
  tsx: brand(siReact, "61dafb"),
  js: JS_BRAND,
  mjs: JS_BRAND,
  cjs: JS_BRAND,
  jsx: brand(siReact, "61dafb"),
  svelte: SVELTE_BRAND,
  vue: brand(siVuedotjs),
  astro: brand(siAstro, "ff5d01"),

  rs: RUST_BRAND,
  go: brand(siGo),
  py: brand(siPython, "3776ab"),
  pyi: brand(siPython, "3776ab"),
  rb: brand(siRuby),
  php: brand(siPhp),
  kt: brand(siKotlin),
  kts: brand(siKotlin),
  swift: brand(siSwift),
  dart: brand(siDart),

  cpp: brand(siCplusplus),
  cc: brand(siCplusplus),
  cxx: brand(siCplusplus),
  hpp: brand(siCplusplus),
  hxx: brand(siCplusplus),
  c: brand(siC, "a8b9cc"),
  h: brand(siC, "a8b9cc"),

  html: brand(siHtml5),
  htm: brand(siHtml5),
  css: brand(siCss, "1572b6"),
  scss: brand(siSass),
  sass: brand(siSass),
  less: brand(siLess),

  json: JSON_BRAND,
  jsonc: JSON_BRAND,
  json5: JSON_BRAND,
  yaml: brand(siYaml, "cb171e"),
  yml: brand(siYaml, "cb171e"),
  toml: brand(siToml, "9c4221"),

  md: MD_BRAND,
  mdx: MD_BRAND,
  markdown: MD_BRAND,

  sh: brand(siGnubash, "9ca3af"),
  bash: brand(siGnubash, "9ca3af"),
  zsh: brand(siGnubash, "9ca3af"),
  ps1: { kind: "category", category: "code" },
  psm1: { kind: "category", category: "code" },

  sqlite: brand(siSqlite),
  sqlite3: brand(siSqlite),
  db: brand(siSqlite),
  graphql: brand(siGraphql),
  gql: brand(siGraphql),

  yarnrc: { kind: "category", category: "code" },

  workflow: brand(siGithubactions),

  png: { kind: "category", category: "image" },
  jpg: { kind: "category", category: "image" },
  jpeg: { kind: "category", category: "image" },
  gif: { kind: "category", category: "image" },
  webp: { kind: "category", category: "image" },
  avif: { kind: "category", category: "image" },
  svg: { kind: "category", category: "image" },
  ico: { kind: "category", category: "image" },
  bmp: { kind: "category", category: "image" },
  tiff: { kind: "category", category: "image" },

  mp4: { kind: "category", category: "video" },
  mov: { kind: "category", category: "video" },
  webm: { kind: "category", category: "video" },
  mkv: { kind: "category", category: "video" },
  avi: { kind: "category", category: "video" },

  mp3: { kind: "category", category: "audio" },
  wav: { kind: "category", category: "audio" },
  ogg: { kind: "category", category: "audio" },
  flac: { kind: "category", category: "audio" },
  m4a: { kind: "category", category: "audio" },

  zip: { kind: "category", category: "archive" },
  tar: { kind: "category", category: "archive" },
  gz: { kind: "category", category: "archive" },
  rar: { kind: "category", category: "archive" },
  "7z": { kind: "category", category: "archive" },
  xz: { kind: "category", category: "archive" },
  bz2: { kind: "category", category: "archive" },

  csv: { kind: "category", category: "spreadsheet" },
  xlsx: { kind: "category", category: "spreadsheet" },
  xls: { kind: "category", category: "spreadsheet" },
  tsv: { kind: "category", category: "spreadsheet" },

  pdf: { kind: "category", category: "doc" },
  doc: { kind: "category", category: "doc" },
  docx: { kind: "category", category: "doc" },
  rtf: { kind: "category", category: "doc" },

  exe: { kind: "category", category: "binary" },
  dll: { kind: "category", category: "binary" },
  so: { kind: "category", category: "binary" },
  dylib: { kind: "category", category: "binary" },
  bin: { kind: "category", category: "binary" },
  wasm: { kind: "category", category: "binary" },

  txt: { kind: "category", category: "text" },
  log: { kind: "category", category: "text" },

  java: { kind: "category", category: "code" },
  scala: { kind: "category", category: "code" },
  clj: { kind: "category", category: "code" },
  ex: { kind: "category", category: "code" },
  exs: { kind: "category", category: "code" },
  elm: { kind: "category", category: "code" },
  erl: { kind: "category", category: "code" },
  hs: { kind: "category", category: "code" },
  lua: { kind: "category", category: "code" },
  nim: { kind: "category", category: "code" },
  pl: { kind: "category", category: "code" },
  r: { kind: "category", category: "code" },
  zig: { kind: "category", category: "code" },
  sql: { kind: "category", category: "code" },
  vim: { kind: "category", category: "code" },
  proto: { kind: "category", category: "code" },
  xml: { kind: "category", category: "code" },
};

export function resolveFileGlyph(filename: string): FileGlyph {
  const lower = filename.toLowerCase();
  const direct = BY_FILENAME[lower];
  if (direct) return direct;

  if (lower.endsWith(".lock")) {
    return { kind: "category", category: "lock" };
  }
  if (lower.startsWith(".env")) {
    return { kind: "category", category: "lock" };
  }
  if (lower === "license" || lower.startsWith("license.")) {
    return { kind: "category", category: "doc" };
  }
  if (lower === "readme" || lower.startsWith("readme.")) {
    return MD_BRAND;
  }
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return DOCKER_BRAND;
  }
  if (lower === "makefile" || lower === "gnumakefile") {
    return { kind: "category", category: "code" };
  }

  const dot = lower.lastIndexOf(".");
  if (dot < 0) return { kind: "category", category: "text" };
  const ext = lower.slice(dot + 1);
  return BY_EXT[ext] ?? { kind: "category", category: "text" };
}
