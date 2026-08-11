# Read label box positions as Visio sees them (dual-link check)
param(
    [string]$InFile = "D:\pi\top\nettopo\test\sample_topology.vsdx"
)

$ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "nettopo_test_" + [System.Guid]::NewGuid().ToString("N") + ".vsdx")
Copy-Item $InFile $tmp -Force

$visio = New-Object -ComObject Visio.Application
$doc = $visio.Documents.Open($tmp)
$page = $doc.Pages.Item(1)

foreach ($shp in $page.Shapes) {
    $txt = ""
    try { $txt = $shp.Text } catch {}
    if ($txt -and $txt.Trim().Length -gt 0 -and -not $shp.OneD) {
        try {
            $px = $shp.CellsU("PinX").ResultIU
            $py = $shp.CellsU("PinY").ResultIU
            $wd = $shp.CellsU("Width").ResultIU
            $ht = $shp.CellsU("Height").ResultIU
            $first = $txt.Substring(0, [Math]::Min(22, $txt.Length)) -replace "`n", "/"
            Write-Output ("LABEL ID=" + $shp.ID + " Pin(" + [math]::Round($px,3) + "," + [math]::Round($py,3) + ") W=" + [math]::Round($wd,3) + " H=" + [math]::Round($ht,3) + " | " + $first)
        } catch {
            Write-Output ("ERR: " + $_.Exception.Message)
        }
    }
}
$doc.Close()
$visio.Quit()
Write-Output "DONE"
