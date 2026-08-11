# Check label box bounding boxes for overlaps (ASCII only)
param(
    [string]$InFile = "D:\pi\top\nettopo\test\sample_topology.vsdx"
)

$ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "nettopo_test_" + [System.Guid]::NewGuid().ToString("N") + ".vsdx")
Copy-Item $InFile $tmp -Force

$visio = New-Object -ComObject Visio.Application
$doc = $visio.Documents.Open($tmp)
$page = $doc.Pages.Item(1)

$boxes = @()
foreach ($shp in $page.Shapes) {
    $txt = ""
    try { $txt = $shp.Text } catch {}
    if ($txt -and $txt.Trim().Length -gt 0 -and -not $shp.OneD) {
        $px = $shp.CellsU("PinX").ResultIU
        $py = $shp.CellsU("PinY").ResultIU
        $wd = $shp.CellsU("Width").ResultIU
        $ht = $shp.CellsU("Height").ResultIU
        $l = $px - $wd / 2; $r = $px + $wd / 2
        $t = $py + $ht / 2; $b = $py - $ht / 2
        $first = $txt.Substring(0, [Math]::Min(18, $txt.Length)) -replace "`n", "/"
        Write-Output ("BOX[" + $shp.ID + "]: L=" + [math]::Round($l,3) + " T=" + [math]::Round($t,3) + " R=" + [math]::Round($r,3) + " B=" + [math]::Round($b,3) + " | " + $first)
        $boxes += ,@($shp.ID, $l, $t, $r, $b)
    }
}

Write-Output "--- overlaps ---"
$overlapCount = 0
for ($i = 0; $i -lt $boxes.Count; $i++) {
    for ($j = $i + 1; $j -lt $boxes.Count; $j++) {
        $a = $boxes[$i]; $b = $boxes[$j]
        $ox = [Math]::Min($a[3], $b[3]) - [Math]::Max($a[1], $b[1])
        $oy = [Math]::Min($a[2], $b[2]) - [Math]::Max($a[4], $b[4])
        if ($ox -gt 0 -and $oy -gt 0) {
            $overlapCount++
            Write-Output ("OVERLAP: " + $a[0] + " x " + $b[0] + " area " + [math]::Round($ox * $oy, 3))
        }
    }
}
Write-Output ("total " + $overlapCount + " overlaps")
$doc.Close()
$visio.Quit()
Write-Output "DONE"
