// ---------- DOM elements ----------
const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const selectBtn = document.getElementById('selectBtn');
const previewContainer = document.getElementById('previewContainer');
const previewImage = document.getElementById('previewImage');
const clearBtn = document.getElementById('clearBtn');
const resultsDiv = document.getElementById('results');
const progressStepsDiv = document.getElementById('progressSteps');
const themeToggle = document.getElementById('themeToggle');
const exportCsvBtn = document.getElementById('exportCsvBtn');
const historyListDiv = document.getElementById('historyList');
const languageSelect = document.getElementById('languageSelect');

// ---------- Global variables ----------
let currentAnalysis = null;
let conversationHistory = [];

// ---------- Multi-language support ----------
let currentLocale = 'en';
const translations = {};

async function loadTranslations(locale) {
    try {
        const res = await fetch(`/static/locales/${locale}.json`);
        if (!res.ok) throw new Error('Translation file not found');
        const data = await res.json();
        translations[locale] = data;
        applyTranslations(locale);
    } catch (err) {
        console.error('Failed to load translations', err);
    }
}

function applyTranslations(locale) {
    const t = translations[locale];
    if (!t) return;
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) {
            if (el.tagName === 'INPUT' && el.placeholder !== undefined) {
                el.placeholder = t[key];
            } else {
                el.innerHTML = t[key];
            }
        }
    });
    const emptyHist = document.querySelector('.empty-history');
    if (emptyHist && t.empty_history) emptyHist.innerHTML = t.empty_history;
    const chatInput = document.getElementById('chatInput');
    if (chatInput && t.chat_placeholder) chatInput.placeholder = t.chat_placeholder;
    const selectBtnText = document.getElementById('selectBtn');
    if (selectBtnText && t.select_btn) selectBtnText.innerHTML = t.select_btn;
    const clearBtnText = document.getElementById('clearBtn');
    if (clearBtnText && t.clear_btn) clearBtnText.innerHTML = t.clear_btn;
    const exportBtn = document.getElementById('exportCsvBtn');
    if (exportBtn && t.export_csv) exportBtn.innerHTML = t.export_csv;
    const sendBtn = document.getElementById('sendChatBtn');
    if (sendBtn && t.send_btn) sendBtn.innerHTML = t.send_btn;
}

async function changeLanguage(locale) {
    currentLocale = locale;
    localStorage.setItem('locale', locale);
    await loadTranslations(locale);
}

const savedLocale = localStorage.getItem('locale') || 'en';
if (languageSelect) languageSelect.value = savedLocale;
loadTranslations(savedLocale).then(() => changeLanguage(savedLocale));
if (languageSelect) {
    languageSelect.addEventListener('change', (e) => changeLanguage(e.target.value));
}

// ---------- Theme (dark/light) ----------
function initTheme() {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') document.body.classList.add('dark');
}
initTheme();
if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        document.body.classList.toggle('dark');
        localStorage.setItem('theme', document.body.classList.contains('dark') ? 'dark' : 'light');
    });
}

// ---------- Utility functions ----------
function updateProgress(stepId, status) {
    const step = document.getElementById(stepId);
    if (!step) return;
    if (status === 'active') {
        step.classList.add('active');
        step.classList.remove('completed');
    } else if (status === 'completed') {
        step.classList.remove('active');
        step.classList.add('completed');
    }
}

function resetProgress() {
    const steps = ['stepUpload', 'stepFeatures', 'stepAnalysis', 'stepReport'];
    steps.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.remove('active', 'completed');
    });
}

async function simulateStep(stepId, delayMs) {
    return new Promise(resolve => {
        updateProgress(stepId, 'active');
        setTimeout(() => {
            updateProgress(stepId, 'completed');
            resolve();
        }, delayMs);
    });
}

// ---------- Load history from backend ----------
async function loadHistory() {
    try {
        const res = await fetch('/history');
        const history = await res.json();
        if (!history.length) {
            historyListDiv.innerHTML = '<p class="empty-history" data-i18n="empty_history">No analyses yet. Upload an image.</p>';
            if (translations[currentLocale] && translations[currentLocale].empty_history) {
                document.querySelector('.empty-history').innerHTML = translations[currentLocale].empty_history;
            }
            return;
        }
        historyListDiv.innerHTML = history.map(item => `
            <div class="history-item" data-id="${item.id}">
                <span class="history-score">O‑RADS ${item.orad_score}</span>
                <span class="history-date">${new Date(item.timestamp).toLocaleString()}</span>
            </div>
        `).join('');
        document.querySelectorAll('.history-item').forEach(el => {
            el.addEventListener('click', () => {
                const id = parseInt(el.dataset.id);
                const analysis = history.find(h => h.id === id);
                if (analysis) displayResultFromHistory(analysis);
            });
        });
    } catch (err) {
        console.error('Failed to load history', err);
    }
}

// ---------- Text-to-Speech (reads analysis results) ----------
function speakText(text) {
    if (!window.speechSynthesis) {
        alert("Your browser does not support speech synthesis.");
        return;
    }
    // Stop any ongoing speech
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    // Try to use the selected language voice if available
    utterance.lang = currentLocale === 'en' ? 'en-US' : (currentLocale === 'es' ? 'es-ES' : (currentLocale === 'hi' ? 'hi-IN' : 'kn-IN'));
    utterance.rate = 0.9;  // slightly slower for clarity
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
}

// ---------- Speech-to-Text (for chat input) ----------
function startSpeechRecognition() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
        alert("Your browser does not support speech recognition.");
        return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = currentLocale === 'en' ? 'en-US' : (currentLocale === 'es' ? 'es-ES' : (currentLocale === 'hi' ? 'hi-IN' : 'kn-IN'));
    
    recognition.onstart = () => {
        const micBtn = document.getElementById('micBtn');
        if (micBtn) {
            micBtn.style.opacity = '0.5';
            micBtn.textContent = '🎤🎙️';
        }
    };
    recognition.onend = () => {
        const micBtn = document.getElementById('micBtn');
        if (micBtn) {
            micBtn.style.opacity = '1';
            micBtn.textContent = '🎤';
        }
    };
    recognition.onresult = (event) => {
        const transcript = event.results[0][0].transcript;
        const chatInput = document.getElementById('chatInput');
        if (chatInput) {
            chatInput.value = transcript;
        }
    };
    recognition.onerror = (event) => {
        console.error("Speech recognition error", event.error);
        alert("Could not recognize speech. Please try again.");
        const micBtn = document.getElementById('micBtn');
        if (micBtn) {
            micBtn.style.opacity = '1';
            micBtn.textContent = '🎤';
        }
    };
    recognition.start();
}

// ---------- PDF generation with language support ----------
async function generatePDF(data, lang) {
    const t = translations[lang] || translations['en'];
    
    // Create a hidden container for the report
    const reportDiv = document.createElement('div');
    reportDiv.id = 'pdf-report-container';
    reportDiv.style.position = 'absolute';
    reportDiv.style.left = '-9999px';
    reportDiv.style.top = '-9999px';
    reportDiv.style.width = '800px';
    reportDiv.style.background = 'white';
    reportDiv.style.padding = '30px';
    reportDiv.style.fontFamily = "'Noto Sans', sans-serif";
    reportDiv.style.fontSize = '14px';
    reportDiv.style.color = '#000';
    reportDiv.style.border = '1px solid #ccc';
    reportDiv.style.borderRadius = '8px';
    
    // Build the HTML content using translations
    const clinical = data.clinical_features;
    reportDiv.innerHTML = `
        <h2 style="color:#2c7da0; margin-bottom:20px;">${t.app_title || 'O‑RADS Ultrasound Analysis Report'}</h2>
        <p><strong>${t.report_date || 'Date'}:</strong> ${new Date().toLocaleString()}</p>
        <p><strong>O-RADS ${t.score || 'Score'}:</strong> ${data.orad_score} (${t.confidence || 'Confidence'}: ${data.confidence}%)</p>
        <p><strong>${t.suggestion || 'Suggestion'}:</strong> ${data.suggestion}</p>
        
        <h3 style="margin-top:20px;">${t.clinical_features || 'Clinical Features'}</h3>
        <ul>
            <li><strong>${t.size_mm || 'Size (mm)'}:</strong> ${clinical.size_mm}</li>
            <li><strong>${t.cyst_type || 'Cyst Type'}:</strong> ${clinical.cyst_type}</li>
            <li><strong>${t.solid_components || 'Solid Components (%)'}:</strong> ${clinical.solid_components_percentage}</li>
            <li><strong>${t.vascularity || 'Vascularity'}:</strong> ${clinical.vascularity}</li>
            <li><strong>${t.septations || 'Septations'}:</strong> ${clinical.septations}</li>
            <li><strong>${t.wall_irregularity || 'Wall Irregularity'}:</strong> ${clinical.wall_irregularity}</li>
        </ul>
        
        <h3 style="margin-top:20px;">${t.ai_analysis || 'AI Analysis'}</h3>
        <p style="white-space: pre-line;">${data.llm_analysis}</p>
        
        <p style="margin-top:30px; font-size:12px; color:#666;">Generated by O‑RADS Ultrasound Analyzer</p>
    `;
    
    document.body.appendChild(reportDiv);
    
    try {
        // Wait for fonts to render (optional but helps)
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const canvas = await html2canvas(reportDiv, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            useCORS: true
        });
        const imgData = canvas.toDataURL('image/png');
        
        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const imgWidth = 210; // A4 width in mm
        const pageHeight = 297;
        const imgHeight = (canvas.height * imgWidth) / canvas.width;
        let position = 0;
        
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        if (imgHeight > pageHeight) {
            // If content is longer than one page, add new pages
            let remaining = imgHeight - pageHeight;
            let currentPos = -pageHeight;
            while (remaining > 0) {
                pdf.addPage();
                pdf.addImage(imgData, 'PNG', 0, currentPos, imgWidth, imgHeight);
                currentPos -= pageHeight;
                remaining -= pageHeight;
            }
        }
        pdf.save(`O-RADS_Report_${Date.now()}.pdf`);
    } catch (err) {
        console.error('PDF generation error:', err);
        alert('Failed to generate PDF. Please try again.');
    } finally {
        document.body.removeChild(reportDiv);
    }
}

// ---------- Display result from history ----------
function displayResultFromHistory(data) {
    const dangerClass = data.orad_score >= 3 ? 'danger' : 'safe';
    const clinical = data.clinical_features;
    const clinicalHtml = `
        <div class="clinical-card">
            <h3>🏥 Clinical Features</h3>
            <div class="feature-grid">
                <div><strong>Size:</strong> ${clinical.size_mm} mm</div>
                <div><strong>Cyst Type:</strong> ${clinical.cyst_type}</div>
                <div><strong>Solid Components:</strong> ${clinical.solid_components_percentage}%</div>
                <div><strong>Vascularity:</strong> ${clinical.vascularity}</div>
                <div><strong>Septations:</strong> ${clinical.septations}</div>
                <div><strong>Wall Irregularity:</strong> ${clinical.wall_irregularity}</div>
            </div>
        </div>
    `;
    resultsDiv.innerHTML = `
        <div class="result-card ${dangerClass}">
            <h2>📊 O-RADS Score: ${data.orad_score}</h2>
            <p><strong>Confidence:</strong> ${data.confidence}%</p>
            <div class="suggestion">${data.suggestion}</div>
            ${clinicalHtml}
            <div class="llm-analysis">
                <h3>🤖 AI Analysis:</h3>
                <p>${(data.llm_analysis || '').replace(/\n/g, '<br>')}</p>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button id="pdfReportBtn" class="btn-primary" data-i18n="download_pdf">📄 Download PDF Report</button>
                <button id="ttsBtn" class="btn-outline">🔊 Read Results</button>
            </div>
            <div class="qr-container">
                <p data-i18n="qr_code_label">Scan QR code to view this analysis on your phone</p>
                <div id="qrCode"></div>
            </div>
            <details>
                <summary>Technical Details</summary>
                <pre>${JSON.stringify(data.image_features, null, 2)}</pre>
            </details>
        </div>
    `;
    resultsDiv.classList.remove('hidden');
    const pdfBtn = document.getElementById('pdfReportBtn');
    if (pdfBtn) {
        pdfBtn.addEventListener('click', () => generatePDF(data, currentLocale));
    }
    const ttsBtn = document.getElementById('ttsBtn');
    if (ttsBtn) {
        ttsBtn.addEventListener('click', () => {
            const textToSpeak = `O-RADS score ${data.orad_score}. ${data.suggestion}. Clinical features: size ${data.clinical_features.size_mm} millimeters, cyst type ${data.clinical_features.cyst_type}, solid components ${data.clinical_features.solid_components_percentage} percent, vascularity ${data.clinical_features.vascularity}, septations ${data.clinical_features.septations}, wall irregularity ${data.clinical_features.wall_irregularity}. ${(data.llm_analysis || '').replace(/\n/g, '. ')}`;
            speakText(textToSpeak);
        });
    }
    // QR code
    const qrDiv = document.getElementById('qrCode');
    if (qrDiv && window.QRCode) {
        qrDiv.innerHTML = '';
        const shortSummary = `O-RADS ${data.orad_score} (${data.confidence}%) | ${clinical.size_mm}mm ${clinical.cyst_type} | Solid ${clinical.solid_components_percentage}% | ${clinical.vascularity}`;
        try {
            new QRCode(qrDiv, { text: shortSummary, width: 100, height: 100 });
        } catch (e) {
            qrDiv.innerHTML = '<p style="color:red;">QR error</p>';
            console.error(e);
        }
    }
    if (translations[currentLocale]) {
        const t = translations[currentLocale];
        if (t.download_pdf && pdfBtn) pdfBtn.innerHTML = t.download_pdf;
        const qrLabel = document.querySelector('.qr-container p');
        if (qrLabel && t.qr_code_label) qrLabel.innerHTML = t.qr_code_label;
    }
}

// ---------- Upload and predict (with language) ----------
async function uploadFile(file) {
    resultsDiv.classList.add('hidden');
    progressStepsDiv.classList.remove('hidden');
    resetProgress();

    const reader = new FileReader();
    reader.onload = (e) => {
        previewImage.src = e.target.result;
        previewContainer.classList.remove('hidden');
    };
    reader.readAsDataURL(file);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('language', currentLocale);

    await simulateStep('stepUpload', 500);
    await simulateStep('stepFeatures', 800);
    updateProgress('stepAnalysis', 'active');

    try {
        const response = await fetch('/predict', { method: 'POST', body: formData });
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        currentAnalysis = data;
        updateProgress('stepAnalysis', 'completed');
        await simulateStep('stepReport', 600);
        progressStepsDiv.classList.add('hidden');
        displayResult(data);
        await loadHistory();
    } catch (err) {
        progressStepsDiv.classList.add('hidden');
        resultsDiv.innerHTML = `<div class="error">Error: ${err.message}</div>`;
        resultsDiv.classList.remove('hidden');
    }
}

function displayResult(data) {
    const dangerClass = data.danger_flag ? 'danger' : 'safe';
    const clinical = data.clinical_features;
    const clinicalHtml = `
        <div class="clinical-card">
            <h3>🏥 Clinical Features</h3>
            <div class="feature-grid">
                <div><strong>Size:</strong> ${clinical.size_mm} mm</div>
                <div><strong>Cyst Type:</strong> ${clinical.cyst_type}</div>
                <div><strong>Solid Components:</strong> ${clinical.solid_components_percentage}%</div>
                <div><strong>Vascularity:</strong> ${clinical.vascularity}</div>
                <div><strong>Septations:</strong> ${clinical.septations}</div>
                <div><strong>Wall Irregularity:</strong> ${clinical.wall_irregularity}</div>
            </div>
        </div>
    `;
    resultsDiv.innerHTML = `
        <div class="result-card ${dangerClass}">
            <h2>📊 O-RADS Score: ${data.orad_score}</h2>
            <p><strong>Confidence:</strong> ${data.confidence}%</p>
            <div class="suggestion">${data.suggestion}</div>
            ${clinicalHtml}
            <div class="llm-analysis">
                <h3>🤖 AI Analysis:</h3>
                <p>${data.llm_analysis.replace(/\n/g, '<br>')}</p>
            </div>
            <div style="display:flex; gap:8px; margin-top:12px;">
                <button id="pdfReportBtn" class="btn-primary" data-i18n="download_pdf">📄 Download PDF Report</button>
                <button id="ttsBtn" class="btn-outline">🔊 Read Results</button>
            </div>
            <div class="qr-container">
                <p data-i18n="qr_code_label">Scan QR code to view this analysis on your phone</p>
                <div id="qrCode"></div>
            </div>
            <details>
                <summary>Technical Details</summary>
                <pre>${JSON.stringify(data.image_features, null, 2)}</pre>
            </details>
        </div>
    `;
    resultsDiv.classList.remove('hidden');
    const pdfBtn = document.getElementById('pdfReportBtn');
    if (pdfBtn) {
        pdfBtn.addEventListener('click', () => generatePDF(data, currentLocale));
    }
    const ttsBtn = document.getElementById('ttsBtn');
    if (ttsBtn) {
        ttsBtn.addEventListener('click', () => {
            const textToSpeak = `O-RADS score ${data.orad_score}. ${data.suggestion}. Clinical features: size ${data.clinical_features.size_mm} millimeters, cyst type ${data.clinical_features.cyst_type}, solid components ${data.clinical_features.solid_components_percentage} percent, vascularity ${data.clinical_features.vascularity}, septations ${data.clinical_features.septations}, wall irregularity ${data.clinical_features.wall_irregularity}. ${data.llm_analysis.replace(/\n/g, '. ')}`;
            speakText(textToSpeak);
        });
    }
    const qrDiv = document.getElementById('qrCode');
    if (qrDiv && window.QRCode) {
        qrDiv.innerHTML = '';
        const shortSummary = `O-RADS ${data.orad_score} (${data.confidence}%) | ${clinical.size_mm}mm ${clinical.cyst_type} | Solid ${clinical.solid_components_percentage}% | ${clinical.vascularity}`;
        try {
            new QRCode(qrDiv, { text: shortSummary, width: 100, height: 100 });
        } catch (e) {
            qrDiv.innerHTML = '<p style="color:red;">QR error</p>';
            console.error(e);
        }
    }
    if (translations[currentLocale]) {
        const t = translations[currentLocale];
        if (t.download_pdf && pdfBtn) pdfBtn.innerHTML = t.download_pdf;
        const qrLabel = document.querySelector('.qr-container p');
        if (qrLabel && t.qr_code_label) qrLabel.innerHTML = t.qr_code_label;
    }
}

// ---------- Export CSV ----------
async function exportCSV() {
    try {
        const res = await fetch('/history');
        const history = await res.json();
        if (!history.length) {
            alert('No history to export.');
            return;
        }
        const headers = ['ID', 'Timestamp', 'O-RADS Score', 'Confidence', 'Suggestion', 'Size mm', 'Cyst Type', 'Solid %', 'Vascularity', 'Wall Irregularity'];
        const rows = history.map(h => {
            const c = h.clinical_features;
            return [h.id, h.timestamp, h.orad_score, h.confidence, h.suggestion, c.size_mm, c.cyst_type, c.solid_components_percentage, c.vascularity, c.wall_irregularity];
        });
        const csvContent = [headers, ...rows].map(row => row.join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `O-RADS_History_${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Failed to export CSV');
    }
}

// ---------- Chat assistant ----------
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendChatBtn = document.getElementById('sendChatBtn');

function addMessageToChat(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.classList.add('message', sender === 'user' ? 'user-message' : 'bot-message');
    msgDiv.textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function sendChatMessage() {
    const msg = chatInput.value.trim();
    if (!msg) return;
    addMessageToChat(msg, 'user');
    conversationHistory.push({ role: 'user', content: msg });
    chatInput.value = '';

    const tempId = 'tempMsg' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.classList.add('message', 'bot-message');
    tempDiv.textContent = '🤔 Thinking...';
    chatMessages.appendChild(tempDiv);

    try {
        const res = await fetch('/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg, history: conversationHistory.slice(0, -1) })
        });
        const data = await res.json();
        document.getElementById(tempId)?.remove();
        if (data.error) {
            addMessageToChat(`⚠️ Error: ${data.error}`, 'bot');
            conversationHistory.push({ role: 'assistant', content: `Error: ${data.error}` });
        } else {
            addMessageToChat(data.answer, 'bot');
            conversationHistory.push({ role: 'assistant', content: data.answer });
        }
    } catch (err) {
        document.getElementById(tempId)?.remove();
        addMessageToChat('❌ Network error. Try again.', 'bot');
    }
}

if (sendChatBtn) sendChatBtn.addEventListener('click', sendChatMessage);
if (chatInput) chatInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendChatMessage(); });

// ---------- Event listeners ----------
if (selectBtn) selectBtn.addEventListener('click', () => fileInput.click());
if (fileInput) fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) uploadFile(e.target.files[0]);
});
if (clearBtn) clearBtn.addEventListener('click', () => {
    previewContainer.classList.add('hidden');
    resultsDiv.classList.add('hidden');
    fileInput.value = '';
    currentAnalysis = null;
});
if (uploadArea) {
    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
    uploadArea.addEventListener('dragleave', () => { uploadArea.classList.remove('drag-over'); });
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) uploadFile(file);
    });
}
if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportCSV);

// Microphone button for speech-to-text
const micBtn = document.getElementById('micBtn');
if (micBtn) {
    micBtn.addEventListener('click', startSpeechRecognition);
}

// Initial load
loadHistory();

// ---------- Interactive O‑RADS Explorer ----------
const canvas = document.getElementById('morphCanvas');
const ctx = canvas ? canvas.getContext('2d') : null;

// Sliders and display spans
const sizeSlider = document.getElementById('sizeSlider');
const solidSlider = document.getElementById('solidSlider');
const vascularSlider = document.getElementById('vascularSlider');
const wallSlider = document.getElementById('wallSlider');
const sizeSpan = document.getElementById('sizeValue');
const solidSpan = document.getElementById('solidValue');
const vascularSpan = document.getElementById('vascularityValue');
const wallSpan = document.getElementById('wallValue');
const previewScoreSpan = document.getElementById('previewScore');
const educationTextDiv = document.getElementById('educationText');

// Map slider values to clinical terms
const vascularMap = ['Absent', 'Minimal', 'Moderate', 'Pronounced'];
const wallMap = ['Smooth', 'Slightly irregular', 'Irregular'];

function updateExplorer() {
    if (!sizeSlider) return;
    
    // Get values
    const size = parseInt(sizeSlider.value);
    const solid = parseInt(solidSlider.value);
    const vascularIdx = parseInt(vascularSlider.value);
    const wallIdx = parseInt(wallSlider.value);
    
    const vascular = vascularMap[vascularIdx];
    const wall = wallMap[wallIdx];
    
    // Update displayed values
    sizeSpan.textContent = size;
    solidSpan.textContent = solid;
    vascularSpan.textContent = vascular;
    wallSpan.textContent = wall;
    
    // Calculate O‑RADS score using same logic as backend (rule‑based)
    let oradScore = 2; // baseline
    if (solid > 30) oradScore += 2;
    else if (solid > 10) oradScore += 1;
    
    if (wall === 'Irregular') oradScore += 2;
    else if (wall === 'Slightly irregular') oradScore += 1;
    
    if (vascular === 'Pronounced' || vascular === 'Extensive') oradScore += 1;
    
    if (size > 100) oradScore += 1;
    
    oradScore = Math.min(5, Math.max(1, oradScore));
    previewScoreSpan.textContent = oradScore;
    
    // Educational text based on score and features
    if (oradScore <= 2) {
        educationTextDiv.innerHTML = `<small>✅ Low risk (&lt;0.5%) – No concerning features. Routine monitoring sufficient.</small>`;
    } else if (oradScore === 3) {
        educationTextDiv.innerHTML = `<small>🟡 Indeterminate (0.5‑5% malignancy risk) – ${solid>10 ? 'Solid components present. ' : ''}${wall.includes('irregular') ? 'Wall irregularity noted. ' : ''}Consider follow‑up imaging in 6‑8 weeks.</small>`;
    } else {
        educationTextDiv.innerHTML = `<small>🔴 Suspicious (${oradScore === 4 ? '5‑50%' : '&gt;50%'} malignancy risk) – ${solid>30 ? 'Significant solid components. ' : ''}${vascular === 'Pronounced' ? 'Increased vascularity. ' : ''}${wall === 'Irregular' ? 'Irregular wall. ' : ''}Urgent gynecologic oncology referral recommended.</small>`;
    }
    
    // Draw synthetic ultrasound image
    drawUltrasound(size, solid, wallIdx, vascularIdx);
}

function drawUltrasound(size, solid, wallIdx, vascularityIdx) {
    if (!ctx) return;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    
    // Background (dark ultrasound-like)
    ctx.fillStyle = '#1a1f2e';
    ctx.fillRect(0, 0, w, h);
    
    // Draw ovary/cyst (ellipse)
    const cystRadius = Math.min(40 + (size / 3), 80);
    const centerX = w/2, centerY = h/2;
    
    // Wall irregularity effect: use different stroke styles
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, cystRadius, cystRadius * 0.8, 0, 0, Math.PI*2);
    
    // Fill based on solid %
    const solidColor = `rgba(200, 180, 140, ${0.2 + solid/100})`;
    ctx.fillStyle = solidColor;
    ctx.fill();
    
    // Wall style
    if (wallIdx === 2) { // irregular
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 3;
        ctx.setLineDash([5, 5]);
    } else if (wallIdx === 1) { // slightly irregular
        ctx.strokeStyle = '#ffb347';
        ctx.lineWidth = 2;
        ctx.setLineDash([2, 3]);
    } else {
        ctx.strokeStyle = '#4caf50';
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
    }
    ctx.stroke();
    
    // Draw vascularity (colored dots/lines inside)
    if (vascularityIdx > 0) {
        ctx.beginPath();
        const dotCount = vascularityIdx * 5;
        for (let i = 0; i < dotCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const rad = cystRadius * 0.7 * Math.random();
            const x = centerX + Math.cos(angle) * rad;
            const y = centerY + Math.sin(angle) * rad * 0.8;
            ctx.fillStyle = `rgba(255, 80, 80, ${0.3 + vascularityIdx * 0.2})`;
            ctx.beginPath();
            ctx.arc(x, y, 2 + vascularityIdx, 0, Math.PI*2);
            ctx.fill();
        }
    }
    
    // Draw solid internal echoes (if solid > 0)
    if (solid > 0) {
        ctx.fillStyle = `rgba(160, 140, 100, ${0.3 + solid/150})`;
        for (let i = 0; i < solid / 5; i++) {
            const sx = centerX + (Math.random() - 0.5) * cystRadius * 1.2;
            const sy = centerY + (Math.random() - 0.5) * cystRadius * 0.9;
            ctx.beginPath();
            ctx.arc(sx, sy, Math.max(2, solid/15), 0, Math.PI*2);
            ctx.fill();
        }
    }
    
    // Label
    ctx.font = "bold 12px 'Noto Sans'";
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 0;
    ctx.fillText("Ovary / Cyst", centerX-35, centerY-10);
    
    // Reset line dash
    ctx.setLineDash([]);
}

// Attach event listeners to sliders
if (sizeSlider) sizeSlider.addEventListener('input', updateExplorer);
if (solidSlider) solidSlider.addEventListener('input', updateExplorer);
if (vascularSlider) vascularSlider.addEventListener('input', updateExplorer);
if (wallSlider) wallSlider.addEventListener('input', updateExplorer);

// Initial draw
if (canvas && ctx) {
    updateExplorer();
}