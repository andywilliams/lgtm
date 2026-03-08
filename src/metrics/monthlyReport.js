import { readReviews } from './reviewLogger.js';

export interface MonthlyReport {
  month: number;
  year: number;
  totalReviews: number;
  falseNegatives: number;
  falseNegativeRate: number;
  contextExpansionCoverage: number;
}

function getMonthRange(month: number, year: number): { start: Date; end: Date } {
  const start = new Date(year, month - 1, 1);
  const end = new month === 12 ? new Date(year + 1, 0, 1) : new Date(year, month, 1);
  return { start, end };
}

function isInMonth(dateStr: string, month: number, year: number): boolean {
  const date = new Date(dateStr);
  return date.getMonth() + 1 === month && date.getFullYear() === year;
}

/**
 * Generate a monthly report with key metrics
 * @param month - Month number (1-12)
 * @param year - Year (e.g., 2026)
 * @returns Monthly summary object
 */
export function generateReport(month: number, year: number): MonthlyReport {
  const reviews = readReviews();
  const monthReviews = reviews.filter(r => isInMonth(r.timestamp, month, year));
  
  const totalReviews = monthReviews.length;
  const falseNegatives = monthReviews.filter(r => r.falseNegative === true).length;
  const withContextExpansion = monthReviews.filter(r => r.expandedContext === true).length;
  
  const falseNegativeRate = totalReviews > 0 
    ? (falseNegatives / totalReviews) * 100 
    : 0;
  
  const contextExpansionCoverage = totalReviews > 0 
    ? (withContextExpansion / totalReviews) * 100 
    : 0;
  
  return {
    month,
    year,
    totalReviews,
    falseNegatives,
    falseNegativeRate: Math.round(falseNegativeRate * 100) / 100,
    contextExpansionCoverage: Math.round(contextExpansionCoverage * 100) / 100,
  };
}

// Allow running directly for testing
if (process.argv[1]?.includes('monthlyReport')) {
  const month = parseInt(process.argv[2]) || new Date().getMonth() + 1;
  const year = parseInt(process.argv[3]) || new Date().getFullYear();
  console.log(`\nMonthly Report for ${year}-${String(month).padStart(2, '0')}:`);
  console.log(JSON.stringify(generateReport(month, year), null, 2));
}
