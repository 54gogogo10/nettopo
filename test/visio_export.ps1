# Export vsdx page to PNG via Visio COM
param(
    [string]$InFile = "D:\pi\top\nettopo\test\sample_topology.vsdx",
    [string]$OutFile = "D:\pi\top\nettopo\test\visio_render.png"
)

$ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "nettopo_test_" + [System.Guid]::NewGuid().ToString("N") + ".vsdx")
Copy-Item $InFile $tmp -Force
Write-Output "STEP1 copied"

$visio = New-Object -ComObject Visio.Application
Write-Output "STEP2 app created"

$doc = $visio.Documents.Open($tmp)
Write-Output "STEP3 opened"

$page = $doc.Pages.Item(1)
Write-Output ("STEP4 page: " + $page.Name + " shapes: " + $page.Shapes.Count)

$page.Export($OutFile)
Write-Output ("STEP5 exported: " + $OutFile)

$doc.Close()
$visio.Quit()
Write-Output "VISIO_EXPORT_OK"
