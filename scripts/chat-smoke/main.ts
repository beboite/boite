import { mount } from "svelte";
import "./fixture.css";
import { loadLocale, setLocale } from "../../src/lib/i18n/index.svelte";
import Fixture from "./Fixture.svelte";

await loadLocale("fr");
setLocale("fr");
mount(Fixture, { target: document.getElementById("app")! });
