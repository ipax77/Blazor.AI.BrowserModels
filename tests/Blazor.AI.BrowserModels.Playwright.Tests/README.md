# Browser tests

These xUnit tests run the real Release-published WASM app, adapter, components and JS interop in Chromium. Only Chrome's `LanguageModel` API is faked, via a test-only initialization script. They do not demonstrate real model quality or Chrome schema support.

## First run

Use the SDK pinned in `global.json`, then run from the repository root:

```powershell
dotnet build tests/Blazor.AI.BrowserModels.Playwright.Tests
pwsh tests/Blazor.AI.BrowserModels.Playwright.Tests/bin/Debug/net11.0/playwright.ps1 install chromium
dotnet test tests/Blazor.AI.BrowserModels.Playwright.Tests
```

On Linux, install Chromium with `install --with-deps chromium`. The fixture publishes the WASM project once, serves its static output under `/playwright/` on an OS-assigned loopback port, and stops the host/browser afterward. It reuses a browser but isolates each test's context. Tests run serially to keep WASM startup CPU and memory costs bounded.

Failed tests write screenshots, traces and bounded browser logs to `artifacts/playwright-results`. Open a trace with `pwsh tests/Blazor.AI.BrowserModels.Playwright.Tests/bin/Debug/net11.0/playwright.ps1 show-trace <trace.zip>`.

## Existing app or published output

```powershell
$env:PWTESTS_SampleBaseUrl = 'https://OWNER.github.io/REPOSITORY/'
dotnet test tests/Blazor.AI.BrowserModels.Playwright.Tests
Remove-Item Env:PWTESTS_SampleBaseUrl
```

Include the application's base path. The URL must not include a query or fragment. No local publish or host runs when this variable is set. Optional `PWTESTS_ExpectedCommit` verifies `commit.txt` before opening the browser; stale deployment content fails explicitly.

To reuse local output instead, set `PWTESTS_PublishedAppPath` to the published **wwwroot** directory (absolute or relative to the repository root). Its `index.html` base determines the local server's path. The fixture does not rewrite supplied artifacts. External URL takes precedence over published output.

## Real Chrome smoke tests

These are skipped unless explicitly enabled. They use installed, headed Chrome with a dedicated persistent test profile, without an injected model fake. Do not point at your everyday Chrome profile. Close other Chrome instances using the test profile before running.

1. Run the demo with `dotnet run --project src/Blazor.AI.BrowserModels.Wasm --urls http://localhost:5188`.
2. Launch installed Chrome with `--user-data-dir=<absolute dedicated test profile path>`, open that URL, and initialize the model manually. Complete any download and confirm text, streaming and typed JSON all work. Consult [Chrome's Prompt API requirements](https://developer.chrome.com/docs/ai/prompt-api) for current browser/hardware support. Close this Chrome instance afterward.
3. Run:

```powershell
$env:PWTESTS_RealModel = '1'
$env:PWTESTS_ChromeUserDataDir = 'C:\path\to\dedicated-chrome-test-profile'
$env:PWTESTS_SampleBaseUrl = 'http://localhost:5188/'
dotnet test tests/Blazor.AI.BrowserModels.Playwright.Tests --filter 'Category=RealModel'
Remove-Item Env:PWTESTS_RealModel, Env:PWTESTS_ChromeUserDataDir, Env:PWTESTS_SampleBaseUrl
```

Each response must complete within three minutes, and tests assert nonempty text and typed JSON structure rather than specific wording. When explicitly enabled, missing APIs, unavailable models, unsupported constraints and initialization failures fail the run. Model setup is not performed by hosted CI. Real-model traces contain the fixed test prompts and model replies.

## GitHub Pages

After publishing the repository, select **Settings → Pages → Source → GitHub Actions**. Push to the default branch or dispatch **Test and publish WASM**. The workflow reads the pinned SDK, validates existing tests and generated JS, tests the Release artifact, deploys that exact artifact, then runs the deterministic suite against the returned URL. Deployment identity is checked against the workflow commit.

Pull requests only test locally under a repository-style subpath. Default-branch runs use the base path from Pages configuration, supporting project sites and custom domains. All app views use root query parameters, so no 404 redirect workaround is needed. A failed deployed check fails the workflow; it does not automatically roll back the site. Diagnostic artifacts expire after seven days.

`scripts/Prepare-Pages.ps1` rewrites only the published base element and writes `commit.txt`/`.nojekyll`. No generated site is committed to a gh-pages branch, and no model fake is included in the deployed app.
