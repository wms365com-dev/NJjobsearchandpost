@echo off
setlocal

cd /d "%~dp0"

set "REMOTE_URL=https://github.com/wms365com-dev/NJjobsearchandpost.git"
set "BRANCH=main"

echo.
echo Preparing to push NJ Job Posting to GitHub...
echo Repo: %REMOTE_URL%
echo.

git config --global --add safe.directory "%CD%"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo This folder is not a Git repository. Initializing Git...
  git init -b %BRANCH%
)

git branch --show-current | findstr /r "^%BRANCH%$" >nul 2>&1
if errorlevel 1 (
  echo Switching to %BRANCH%...
  git checkout -B %BRANCH%
)

git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo Adding origin remote...
  git remote add origin %REMOTE_URL%
) else (
  echo Updating origin remote...
  git remote set-url origin %REMOTE_URL%
)

echo.
echo Checking for local changes...
git status --porcelain > "%TEMP%\nj-job-git-status.txt"
for %%A in ("%TEMP%\nj-job-git-status.txt") do set "STATUS_SIZE=%%~zA"

if not "%STATUS_SIZE%"=="0" (
  echo Local changes found. Creating a commit...
  git add .env.example .gitignore README.md package-lock.json package.json public/index.html railway.json server.js push-to-github.bat
  git commit -m "Update Railway job posting dashboard"
) else (
  echo No local changes to commit.
)

del "%TEMP%\nj-job-git-status.txt" >nul 2>&1

echo.
echo Pushing to GitHub...
git push -u origin %BRANCH%
if errorlevel 1 (
  echo.
  echo Push failed. Make sure you have access to the repo and Git is authenticated.
  echo You may need to sign in with Git Credential Manager when prompted.
  pause
  exit /b 1
)

echo.
echo Done. Pushed %BRANCH% to %REMOTE_URL%
pause
