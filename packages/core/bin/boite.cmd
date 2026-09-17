@echo off
rem The `boite` CLI from the sources: what a thread's PATH carries in development.
bun run "%~dp0core.ts" cli %*
