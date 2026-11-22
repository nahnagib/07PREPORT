# Removes the DEFINER=`user`@`host` clauses from a mysqldump file, in place, for the local TEST stack restore
# (test-stack-start.cmd). The test database's app user has no SUPER / SET_USER_ID privilege, so a view defined by
# `powerbi_user`@`localhost` (production's account) cannot be recreated as is; without the clause MySQL makes the
# restoring user the definer. Only the local dump file is changed: production is never touched.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test-stack-strip-definers.ps1 -Path <dump.sql>
#
# Streams the file (it is over 1 GB) and reads/writes it as Latin-1, so every byte other than the removed clauses is
# copied unchanged (binary column data included). Prints how many clauses it removed.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'

$src = (Resolve-Path -LiteralPath $Path).Path
$tmp = "$src.nodefiner.tmp"
$latin1 = [System.Text.Encoding]::GetEncoding(28591)
# `DEFINER=` + a back-quoted user + @ + a back-quoted host, with the space after it (views, triggers, routines, events).
$definer = New-Object System.Text.RegularExpressions.Regex 'DEFINER=`(?:[^`]|``)*`@`(?:[^`]|``)*`\s?'
$removed = 0

$reader = New-Object System.IO.StreamReader($src, $latin1, $false, 1048576)
$writer = New-Object System.IO.StreamWriter($tmp, $false, $latin1, 1048576)
$writer.NewLine = "`n"
try {
  while ($null -ne ($line = $reader.ReadLine())) {
    # Only short DDL lines carry a definer; the multi-MB INSERT lines are copied without a regex pass.
    if ($line.Length -lt 4096 -and $line.Contains('DEFINER=')) {
      $removed += $definer.Matches($line).Count
      $line = $definer.Replace($line, '')
    }
    $writer.WriteLine($line)
  }
} finally {
  $reader.Close()
  $writer.Close()
}
Move-Item -LiteralPath $tmp -Destination $src -Force
Write-Output "Removed $removed DEFINER clause(s) from $src"
