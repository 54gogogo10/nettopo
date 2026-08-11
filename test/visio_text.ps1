# Read text content of label boxes as Visio parsed them
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
    if ($txt -and $txt.Trim().Length -gt 0) {
        # 输出字符编码，检查是否正常
        $codes = ($txt.ToCharArray() | ForEach-Object { [int][char]$_ }) -join ","
        $codes = $txt.ToCharArray() | ForEach-Object { [int][char]$_ }
        $codeStr = ($codes -join ",")
        if ($codeStr.Length -gt 120) { $codeStr = $codeStr.Substring(0,120) }
        Write-Output ("TEXT: " + $txt + "  CODES: " + $codeStr)
        # 字体
        try {
            $f = $shp.CellsSRC(11, 0, 1).FormulaU  # Character section, row 0, Font cell
            Write-Output ("  Font formula: " + $f)
        } catch {}
    }
}

$doc.Close()
$visio.Quit()
Write-Output "DONE"
