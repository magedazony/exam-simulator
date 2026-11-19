@echo off
rem Double-click to publish your changes: GitHub -> Render -> live site.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish.ps1"
