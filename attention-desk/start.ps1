param(
  [switch]$Install
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if ($Install) {
  npm install
  if (Test-Path "..\.venv\Scripts\python.exe") {
    & "..\.venv\Scripts\python.exe" -m pip install -r server\requirements.txt
  } else {
    python -m pip install -r server\requirements.txt
  }
}

$python = if (Test-Path "..\.venv\Scripts\python.exe") { "..\.venv\Scripts\python.exe" } else { "python" }
Start-Process -FilePath $python -ArgumentList "-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", "8765" -WorkingDirectory $root
npm run dev -- --host 127.0.0.1
