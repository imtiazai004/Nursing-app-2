import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { MCQQuestion, SummaryResult } from '../services/gemini';

export const exportSummaryToPDF = (summary: SummaryResult, topic: string) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();
  
  // Header
  doc.setFillColor(67, 56, 202); // indigo-700
  doc.rect(0, 0, pageWidth, 40, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.text('Nursify Study Summary', 20, 25);
  
  doc.setFontSize(10);
  doc.text(`Topic: ${topic}`, 20, 33);
  doc.text(`Generated on: ${new Date().toLocaleDateString()}`, pageWidth - 20, 33, { align: 'right' });

  // Body
  doc.setTextColor(20, 20, 20);
  doc.setFontSize(16);
  doc.text('Evidence Synthesis', 20, 55);
  
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  
  // Simple markdown-ish text splitting for summary content
  const splitText = doc.splitTextToSize(summary.content.replace(/[#*`]/g, ''), pageWidth - 40);
  doc.text(splitText, 20, 65);

  let currentY = 65 + (splitText.length * 5) + 15;

  // Recommendations
  if (summary.recommendations && summary.recommendations.length > 0) {
    if (currentY > 240) {
      doc.addPage();
      currentY = 20;
    }
    
    doc.setFontSize(14);
    doc.text('Recommended Resources', 20, currentY);
    currentY += 10;
    
    summary.recommendations.forEach((rec, index) => {
      doc.setFontSize(10);
      doc.setTextColor(67, 56, 202);
      doc.text(`${index + 1}. ${rec.title}`, 25, currentY);
      currentY += 5;
      doc.setTextColor(100, 100, 100);
      doc.setFontSize(8);
      doc.text(rec.url, 25, currentY);
      currentY += 10;
      
      if (currentY > 270) {
        doc.addPage();
        currentY = 20;
      }
    });
  }

  // Footer on all pages
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('Nursify - Intelligent Nursing Study Assistant', pageWidth / 2, 285, { align: 'center' });
  }

  doc.save(`Nursify_Summary_${topic.replace(/\s+/g, '_')}.pdf`);
};

export const exportQuizToPDF = (questions: MCQQuestion[], topic: string) => {
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  // Header
  doc.setFillColor(67, 56, 202);
  doc.rect(0, 0, pageWidth, 40, 'F');
  
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.text('Nursify MCQ Sandbox', 20, 25);
  
  doc.setFontSize(10);
  doc.text(`Topic: ${topic}`, 20, 33);
  doc.text(`Total Questions: ${questions.length}`, pageWidth - 20, 33, { align: 'right' });

  // Quiz content using autoTable for clean layout
  const tableData = questions.map((q, index) => [
    `${index + 1}`,
    `${q.question}\n\nOptions:\n${q.options.map((opt, i) => `   ${String.fromCharCode(65 + i)}) ${opt}`).join('\n')}\n\nCorrect Answer: ${q.correctAnswer}\nRationale: ${q.explanation}`
  ]);

  autoTable(doc, {
    startY: 50,
    head: [['#', 'Clinical Case Study & Analysis']],
    body: tableData,
    theme: 'striped',
    headStyles: { fillColor: [67, 56, 202] },
    columnStyles: {
      0: { cellWidth: 10 },
      1: { cellWidth: 'auto' }
    },
    styles: { fontSize: 9, cellPadding: 5 },
    margin: { left: 20, right: 20 }
  });

  // Footer
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(8);
    doc.setTextColor(150, 150, 150);
    doc.text('Nursify - Intelligent Nursing Study Assistant', pageWidth / 2, 285, { align: 'center' });
  }

  doc.save(`Nursify_Quiz_${topic.replace(/\s+/g, '_')}.pdf`);
};
