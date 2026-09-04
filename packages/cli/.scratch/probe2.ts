import { PDFDocument, StandardFonts } from 'pdf-lib';
const doc = await PDFDocument.create();
doc.setProducer('probe-producer');
doc.setCreator('probe-creator');
doc.setTitle('t');
const font = await doc.embedFont(StandardFonts.Helvetica);
doc.addPage([420, 595]).drawText('Hola prova 123', { x: 40, y: 500, size: 24, font });
const bytes = await doc.save();
console.log(Buffer.from(bytes).toString('latin1'));
