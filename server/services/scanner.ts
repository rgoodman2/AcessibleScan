import { JSDOM } from "jsdom";
import axe from "axe-core";
import PDFDocument from "pdfkit";
import fs from "fs";
import { mkdir, readFile } from "fs/promises";
import path from "path";
import fetch from "node-fetch";
// Using Node's built-in setTimeout
import { createCanvas, Image, loadImage } from "canvas";
import puppeteer from "puppeteer";

/**
 * Scans a local test page instead of fetching an external website
 * This is used for testing when external network access is restricted
 */
async function scanTestPage(testPagePath: string): Promise<ScanResult> {
  try {
    console.log(`Loading test page: ${testPagePath}`);
    
    // Get the absolute path to the test page
    const fullPath = path.join(process.cwd(), 'server', testPagePath.replace(/^\//, ''));
    console.log(`Full path: ${fullPath}`);
    
    // Read the HTML content
    const htmlContent = await readFile(fullPath, 'utf-8');
    console.log(`Test page loaded: ${htmlContent.length} bytes`);
    
    // Create a virtual DOM with the fetched content
    const dom = new JSDOM(htmlContent, {
      url: `file://${fullPath}`,
      runScripts: "outside-only",
      resources: "usable",
      pretendToBeVisual: true
    });
    
    const { window } = dom;
    const { document } = window;
    
    console.log('Test page loaded in virtual DOM');
    
    // Configure axe-core
    // @ts-ignore - Ignoring typing issue with axe configuration
    const axeConfig = {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'best-practice']
      }
    };
    
    // Run axe-core for accessibility testing
    // @ts-ignore - axe-core typing issue with JSDOM
    const results = await axe.run(document, axeConfig);
    
    console.log(`Test page scan complete - ${results.violations.length} violations found`);
    
    return {
      violations: results.violations,
      passes: results.passes,
      incomplete: results.incomplete,
      scanDateTime: new Date().toISOString(),
      url: testPagePath
    };
  } catch (error) {
    console.error('Error scanning test page:', error);
    throw error;
  }
}

interface ScanResult {
  violations: any[];
  passes: any[];
  incomplete: any[];
  screenshot?: string; // Base64 encoded screenshot (deprecated)
  error?: string;      // Error message if scan failed
  scanDateTime?: string; // ISO timestamp of when scan was performed
  url?: string;        // URL that was scanned
}

export async function generateBasicReport(url: string): Promise<string> {
  const timestamp = Date.now();
  const filename = `scan_${timestamp}.pdf`;
  const reportsDir = path.join(process.cwd(), 'reports');
  
  // Ensure reports directory exists
  try {
    await mkdir(reportsDir, { recursive: true });
  } catch (error) {
    console.log('Reports directory already exists or could not be created');
  }
  
  const reportPath = path.join(reportsDir, filename);
  
  try {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(reportPath);
    doc.pipe(stream);
    
    // Add basic report content
    doc.fontSize(20).text('Accessibility Scan Report', 50, 50);
    doc.fontSize(12).text(`URL: ${url}`, 50, 100);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 50, 120);
    doc.text('This is a basic test report.', 50, 160);
    
    doc.end();
    
    return new Promise((resolve, reject) => {
      stream.on('finish', () => {
        console.log(`Basic report generated: ${reportPath}`);
        resolve(reportPath);
      });
      stream.on('error', reject);
    });
  } catch (error) {
    console.error('Error generating basic report:', error);
    throw error;
  }
}
async function captureScreenshot(url: string): Promise<string | null> {
  let browser = null;
  try {
    console.log('Attempting to capture screenshot...');
    
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    // Set a reasonable timeout
    await page.goto(url, { 
      waitUntil: 'networkidle0', 
      timeout: 30000 
    });
    
    const screenshot = await page.screenshot({ 
      type: 'png',
      fullPage: false // Just capture the viewport
    });
    
    console.log('Screenshot captured successfully');
    return screenshot.toString('base64');
  } catch (error) {
    console.log('Screenshot capture failed:', error);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export async function scanWebsite(url: string): Promise<ScanResult> {
  console.log(`Starting scan for URL: ${url}`);
  
  // Check if this is a test page request
  if (['test', 'test-sample', 'test-accessible'].includes(url)) {
    console.log('Detected test page request, scanning local test files');
    
    let testPagePath;
    switch (url) {
      case 'test':
      case 'test-sample':
        testPagePath = 'test-pages/sample.html';
        break;
      case 'test-accessible':
        testPagePath = 'test-pages/accessible.html';
        break;
      default:
        testPagePath = 'test-pages/index.html';
    }
    
    return await scanTestPage(testPagePath);
  }
  
  // For external URLs, attempt to fetch and scan
  try {
    console.log(`Fetching content from: ${url}`);
    
    // Try multiple user agents for better compatibility
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    ];
    
    let response;
    let lastError;
    
    // Try each user agent
    for (const userAgent of userAgents) {
      try {
        console.log(`Trying with user agent: ${userAgent.substring(0, 50)}...`);
        
        response = await fetch(url, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
          },
          timeout: 15000,
        });
        
        if (response.ok) {
          console.log(`Successfully fetched content with status: ${response.status}`);
          break;
        } else {
          console.log(`HTTP ${response.status}: ${response.statusText}`);
          lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (fetchError) {
        console.log(`Fetch attempt failed: ${fetchError}`);
        lastError = fetchError;
        continue;
      }
    }
    
    if (!response || !response.ok) {
      throw lastError || new Error('All fetch attempts failed');
    }
    
    const html = await response.text();
    console.log(`Retrieved HTML content: ${html.length} characters`);
    
    // Create a virtual DOM with the fetched content
    const dom = new JSDOM(html, {
      url: url,
      runScripts: "outside-only",
      resources: "usable",
      pretendToBeVisual: true
    });
    
    const { window } = dom;
    const { document } = window;
    
    console.log('Content loaded in virtual DOM');
    
    // Configure axe-core for comprehensive accessibility testing
    const axeConfig = {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']
      }
    };
    
    // Run axe-core for accessibility testing
    // @ts-ignore - axe-core typing issue with JSDOM
    const results = await axe.run(document, axeConfig);
    
    console.log(`Accessibility scan complete - ${results.violations.length} violations, ${results.passes.length} passes`);
    
    // Attempt to capture screenshot (may fail in restricted environments)
    const screenshot = await captureScreenshot(url);
    
    return {
      violations: results.violations,
      passes: results.passes,
      incomplete: results.incomplete,
      screenshot: screenshot || undefined,
      scanDateTime: new Date().toISOString(),
      url: url
    };
    
  } catch (error) {
    console.error('Error during website scan:', error);
    
    // Return error information instead of throwing
    return {
      violations: [],
      passes: [],
      incomplete: [],
      error: error instanceof Error ? error.message : String(error),
      scanDateTime: new Date().toISOString(),
      url: url
    };
  }
}
export async function generateReport(url: string, results: ScanResult): Promise<string> {
  const timestamp = Date.now();
  const filename = `scan_${timestamp}.pdf`;
  const reportsDir = path.join(process.cwd(), 'reports');
  
  // Ensure reports directory exists
  try {
    await mkdir(reportsDir, { recursive: true });
  } catch (error) {
    console.log('Reports directory already exists or could not be created');
  }
  
  const reportPath = path.join(reportsDir, filename);
  
  try {
    const doc = new PDFDocument();
    const stream = fs.createWriteStream(reportPath);
    doc.pipe(stream);
    
    // Header
    doc.fontSize(20).text('Web Accessibility Scan Report', 50, 50);
    doc.fontSize(12).text(`URL: ${url}`, 50, 90);
    doc.text(`Scan Date: ${results.scanDateTime ? new Date(results.scanDateTime).toLocaleString() : new Date().toLocaleString()}`, 50, 110);
    doc.text(`Generated by AccessScan`, 50, 130);
    
    let yPosition = 170;
    
    // Error handling
    if (results.error) {
      doc.fontSize(16).fillColor('red').text('Scan Error', 50, yPosition);
      yPosition += 30;
      doc.fontSize(12).fillColor('black').text(results.error, 50, yPosition, { width: 500 });
      yPosition += 60;
      
      doc.text('This error may be due to network restrictions or website accessibility issues.', 50, yPosition);
      yPosition += 20;
      doc.text('For testing purposes, you can use "test" as the URL to scan sample pages.', 50, yPosition);
    } else {
      // Summary
      doc.fontSize(16).fillColor('black').text('Summary', 50, yPosition);
      yPosition += 30;
      
      doc.fontSize(12).text(`Total Violations: ${results.violations.length}`, 50, yPosition);
      yPosition += 20;
      doc.text(`Tests Passed: ${results.passes.length}`, 50, yPosition);
      yPosition += 20;
      doc.text(`Incomplete Tests: ${results.incomplete.length}`, 50, yPosition);
      yPosition += 40;
      
      // Violations
      if (results.violations.length > 0) {
        doc.fontSize(16).fillColor('red').text('Accessibility Violations', 50, yPosition);
        yPosition += 30;
        
        results.violations.forEach((violation, index) => {
          if (yPosition > 700) {
            doc.addPage();
            yPosition = 50;
          }
          
          doc.fontSize(14).fillColor('black').text(`${index + 1}. ${violation.id}`, 50, yPosition);
          yPosition += 20;
          
          doc.fontSize(10).text(`Impact: ${violation.impact}`, 70, yPosition);
          yPosition += 15;
          
          doc.fontSize(10).text(`Description: ${violation.description}`, 70, yPosition, { width: 500 });
          yPosition += 30;
          
          if (violation.nodes && violation.nodes.length > 0) {
            doc.text('Affected Elements:', 70, yPosition);
            yPosition += 15;
            
            violation.nodes.slice(0, 3).forEach((node: any) => {
              if (node.html) {
                doc.fontSize(8).text(`• ${node.html.substring(0, 100)}...`, 90, yPosition);
                yPosition += 12;
              }
            });
            
            if (violation.nodes.length > 3) {
              doc.text(`... and ${violation.nodes.length - 3} more elements`, 90, yPosition);
              yPosition += 12;
            }
          }
          
          yPosition += 20;
        });
      }
      
      // Passes (summary only)
      if (results.passes.length > 0) {
        if (yPosition > 650) {
          doc.addPage();
          yPosition = 50;
        }
        
        doc.fontSize(16).fillColor('green').text('Tests Passed', 50, yPosition);
        yPosition += 30;
        
        doc.fontSize(12).fillColor('black').text(`${results.passes.length} accessibility tests passed successfully.`, 50, yPosition);
        yPosition += 30;
        
        // List first few passed tests
        results.passes.slice(0, 5).forEach((pass, index) => {
          doc.fontSize(10).text(`• ${pass.id}: ${pass.description}`, 70, yPosition);
          yPosition += 15;
        });
        
        if (results.passes.length > 5) {
          doc.text(`... and ${results.passes.length - 5} other tests passed`, 70, yPosition);
        }
      }
    }
    
    // Footer
    doc.fontSize(8).fillColor('gray').text('Generated by AccessScan - Web Accessibility Scanner', 50, 750);
    
    doc.end();
    
    return new Promise((resolve, reject) => {
      stream.on('finish', () => {
        console.log(`Report generated: ${reportPath}`);
        resolve(reportPath);
      });
      stream.on('error', reject);
    });
  } catch (error) {
    console.error('Error generating report:', error);
    throw error;
  }
}
