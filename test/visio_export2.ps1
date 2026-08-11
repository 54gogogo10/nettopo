param(
    [string]$InFile = "D:\pi\top\nettopo\test\sample_topology.vsdx",
    [string]$OutFile = "D:\pi\top\nettopo\test\visio_render_hi.png"
)
$ErrorActionPreference = "Continue"
$tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "nettopo_test_" + [System.Guid]::NewGuid().ToString("N") + ".vsdx")
Copy-Item $InFile $tmp -Force
$visio = New-Object -ComObject Visio.Application
$doc = $visio.Documents.Open($tmp)
$page = $doc.Pages.Item(1)
try {
    # Export(Filename, Filter, ApplyTheme, RGBColor, Background, Width, Height, Resolution)
    $page.Export($OutFile, "PNG", $false, 0, $false, 3000, 0, 150)
    Write-Output "EXPORT_OK_3000"
} catch {
    Write-Output ("EXPORT_ERR: " + $_.Exception.Message)
    try {
        $page.Export($OutFile, "", $false, 0, $false, 3000, 0, 150)
        Write-Output "EXPORT_OK_3000_B"
    } catch {
        Write-Output ("EXPORT_ERR2: " + $_.Exception.Message)
        $page.Export($OutFile)
        Write-Output "EXPORT_OK_DEFAULT"
    }
}
$doc.Close()
$visio.Quit()
