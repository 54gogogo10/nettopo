# Read actual line geometry after Visio opens the vsdx
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
    $is1D = $false
    try { $is1D = $shp.OneD } catch {}
    if ($is1D) {
        try {
            $bx = $shp.CellsU("BeginX").ResultIU
            $by = $shp.CellsU("BeginY").ResultIU
            $ex = $shp.CellsU("EndX").ResultIU
            $ey = $shp.CellsU("EndY").ResultIU
            $px = $shp.CellsU("PinX").ResultIU
            $py = $shp.CellsU("PinY").ResultIU
            $wd = $shp.CellsU("Width").ResultIU
            $ang = $shp.CellsU("Angle").ResultIU
            $txt = ""
            try { $txt = $shp.Text } catch {}
            Write-Output ("LINE: Begin(" + [math]::Round($bx,3) + "," + [math]::Round($by,3) + ") End(" + [math]::Round($ex,3) + "," + [math]::Round($ey,3) + ") Pin(" + [math]::Round($px,3) + "," + [math]::Round($py,3) + ") W=" + [math]::Round($wd,3) + " Ang=" + [math]::Round($ang,4) + " | " + $txt)
        } catch {
            Write-Output ("LINE_ERR: " + $_.Exception.Message)
        }
    } else {
        try {
            $px = $shp.CellsU("PinX").ResultIU
            $py = $shp.CellsU("PinY").ResultIU
            $wd = $shp.CellsU("Width").ResultIU
            $ht = $shp.CellsU("Height").ResultIU
            Write-Output ("BOX:   Pin(" + [math]::Round($px,3) + "," + [math]::Round($py,3) + ") W=" + [math]::Round($wd,3) + " H=" + [math]::Round($ht,3))
        } catch {
            Write-Output ("BOX_ERR: " + $_.Exception.Message)
        }
    }
}

$doc.Close()
$visio.Quit()
Write-Output "DONE"
