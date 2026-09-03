import { describe, expect, it } from "vitest";
import { whenSentence, type WhenPhrases } from "./when-sentence";

const EN: WhenPhrases = {
  or: ", or ",
  and: " and ",
  not: "not ",
  tokens: {
    settingsOpen: "settings open",
    editorFocus: "editor focused",
    projectFocus: "project view focused",
    homeFocus: "home focused",
    overlayOpen: "an overlay is open",
    terminalFocus: "terminal focused",
    paletteOpen: "palette open",
    modalOpen: "a dialog is open",
    inputFocus: "an input is focused",
    hasThread: "a terminal is selected",
  },
};

const FR: WhenPhrases = {
  or: ", ou ",
  and: " et ",
  not: "pas ",
  tokens: {
    settingsOpen: "réglages ouverts",
    editorFocus: "éditeur actif",
    projectFocus: "vue projet active",
    homeFocus: "accueil actif",
    overlayOpen: "une surcouche est ouverte",
    terminalFocus: "terminal actif",
    paletteOpen: "palette ouverte",
    modalOpen: "une boîte de dialogue est ouverte",
    inputFocus: "un champ est actif",
    hasThread: "un terminal est sélectionné",
  },
};

const ESCAPE =
  "(settingsOpen || editorFocus || projectFocus || homeFocus) && !overlayOpen";

describe("whenSentence", () => {
  it("renders the escape-key clause as a sentence", () => {
    expect(whenSentence(ESCAPE, EN)).toBe(
      "(settings open, or editor focused, or project view focused, or home focused) and not an overlay is open",
    );
    expect(whenSentence(ESCAPE, FR)).toBe(
      "(réglages ouverts, ou éditeur actif, ou vue projet active, ou accueil actif) et pas une surcouche est ouverte",
    );
  });

  it("keeps parentheses and leaves an unknown token alone", () => {
    expect(whenSentence("terminalFocus && !overlayOpen", EN)).toBe(
      "terminal focused and not an overlay is open",
    );
    expect(whenSentence("!modalOpen", EN)).toBe("not a dialog is open");
    expect(whenSentence("neverHeardOfIt && !overlayOpen", EN)).toBe(
      "neverHeardOfIt and not an overlay is open",
    );
  });
});
