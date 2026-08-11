# Diagnostics: open vsdx via Visio COM
param(
    [string]$InFile = "D:\pi\top\nettopo\test\sample_topology.vsdx"
)

$ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "nettopo_test_" + [System.Guid]::NewGuid().ToString("N") + ".vsdx")
Copy-Item $InFile $tmp -Force
Write-Output ("TMP: " + $tmp + " EXISTS: " + (Test-Path $tmp))

$visio = $null
try {
    $visio = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Visio.Application")
    Write-Output "CONNECTED_EXISTING"
} catch {
    $visio = New-Object -ComObject Visio.Application
    $visio.Visible = $true
    Write-Output "STARTED_NEW"
}
Write-Output ("DOCS: " + $visio.Documents.Count)

$doc = $null
try {
    $doc = $visio.Documents.Open($tmp)
    Write-Output ("OPEN_OK: " + ($doc -ne $null))
} catch {
    Write-Output ("OPEN_ERR: " + $_.Exception.Message)
}
if ($doc) {
    try {
        Write-Output ("PAGES: " + $doc.Pages.Count)
        $page = $doc.Pages.Item(1)
        Write-Output ("PAGE: " + $page.Name + " SHAPES: " + $page.Shapes.Count)
    } catch {
        Write-Output ("PAGE_ERR: " + $_.Exception.Message)
    }
    try { $doc.Close() } catch {}
}
try { $visio.Quit() } catch {}
Write-Output "DONE"
