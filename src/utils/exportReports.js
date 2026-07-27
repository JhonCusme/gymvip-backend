const ExcelJS = require('exceljs');

// Genera un Excel del reporte de ingresos
async function generateRevenueExcel(data, gym) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = gym.name || 'GymVIP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Ingresos');

  // Color primario del gym (sin el #)
  const primaryColor = (gym.primary_color || '#E85D04').replace('#', '');

  // Título
  sheet.mergeCells('A1:D1');
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Reporte de Ingresos — ${gym.name || ''}`;
  titleCell.font = { size: 16, bold: true, color: { argb: 'FF' + primaryColor } };
  titleCell.alignment = { horizontal: 'center' };

  // Fecha de generación
  sheet.mergeCells('A2:D2');
  const dateCell = sheet.getCell('A2');
  dateCell.value = `Generado: ${new Date().toLocaleDateString('es-EC')}`;
  dateCell.font = { size: 10, italic: true, color: { argb: 'FF888888' } };
  dateCell.alignment = { horizontal: 'center' };

  sheet.addRow([]);

  // Encabezados de la tabla de métodos
  const headerRow = sheet.addRow(['Método de Pago', 'Monto']);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + primaryColor } };
    cell.alignment = { horizontal: 'left' };
  });

  // Datos de ingresos por método
  const rev = data.revenue || {};
  sheet.addRow(['Efectivo', parseFloat(rev.efectivo || 0)]);
  sheet.addRow(['Tarjeta/Transferencia', parseFloat(rev.tarjeta_transfer || 0)]);
  sheet.addRow(['PayPhone', parseFloat(rev.payphone || 0)]);

  // Total
  const totalRow = sheet.addRow(['TOTAL', parseFloat(rev.total || 0)]);
  totalRow.eachCell(cell => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
  });

  // Formato de moneda en la columna de montos
  sheet.getColumn(2).numFmt = '"$"#,##0.00';
  sheet.getColumn(1).width = 28;
  sheet.getColumn(2).width = 16;

  return workbook;
}

module.exports = { generateRevenueExcel };