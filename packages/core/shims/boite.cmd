@echo off
rem The `boite` CLI of an installed Boite: the runtime beside this file runs the core bundle, which answers it.
"%~dp0boite-core.exe" "%~dp0core\main.js" cli %*
