param(
    [Parameter(Mandatory)][string]$PublishedRoot,
    [Parameter(Mandatory)][string]$BasePath,
    [Parameter(Mandatory)][string]$Commit
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $PublishedRoot).Path
$pathBase = '/' + $BasePath.Trim('/')
if ($pathBase -ne '/') { $pathBase += '/' }
if ($pathBase -match '["<>?&#]') { throw 'BasePath must be a URL path.' }
$index = Join-Path $root 'index.html'
$html = [IO.File]::ReadAllText($index)
if ($html -notmatch '<base href="[^"]*"\s*/?>') { throw 'index.html has no base element.' }
$html = [regex]::Replace($html, '<base href="[^"]*"\s*/?>', ('<base href="' + $pathBase + '" />'))
[IO.File]::WriteAllText($index, $html)
[IO.File]::WriteAllText((Join-Path $root 'commit.txt'), $Commit + "`n")
[IO.File]::WriteAllText((Join-Path $root '.nojekyll'), '')
