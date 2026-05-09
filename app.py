import os
import json
from flask import Flask, request, jsonify, render_template, session
from werkzeug.utils import secure_filename
from model import ORadPredictor
from groq import Groq
from dotenv import load_dotenv
from datetime import datetime
from transformers import CLIPProcessor, CLIPModel
import torch
from PIL import Image

load_dotenv()

app = Flask(__name__)
app.secret_key = os.urandom(24)
app.config['UPLOAD_FOLDER'] = 'uploads'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

predictor = ORadPredictor()

# ---------- Load CLIP model for image validation (once at startup) ----------
print("Loading CLIP model for image validation...")
clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32")
clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
print("CLIP model loaded.")

# In-memory history storage
analysis_history = []

# Groq client (for chat)
client = Groq(api_key=os.getenv("GROQ_API_KEY"))
CHAT_MODEL = "llama-3.1-8b-instant"

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def is_ovarian_ultrasound(image_path, threshold=0.5):
    """
    Returns True if the image is likely an ovarian ultrasound.
    Uses CLIP to compare image against text prompts.
    """
    try:
        image = Image.open(image_path).convert("RGB")
        
        # Define prompts: first is the desired category, others are negative examples
        texts = [
            "ultrasound image of a human ovary",
            "photograph of a car or outdoor scene",
            "x-ray of a chest or bone",
            "MRI scan of a brain",
            "CT scan of abdomen",
            "photo of a dog or cat",
            "document or text image"
        ]
        
        inputs = clip_processor(text=texts, images=image, return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs = clip_model(**inputs)
        logits_per_image = outputs.logits_per_image  # shape: (1, num_texts)
        probs = logits_per_image.softmax(dim=1)       # convert to probabilities
        
        ovary_prob = probs[0][0].item()               # probability of being ovarian ultrasound
        print(f"CLIP confidence: {ovary_prob:.2f}")
        
        return ovary_prob > threshold
    except Exception as e:
        print(f"CLIP validation error: {e}")
        return False

# ---------- Translation dictionaries for dynamic text ----------
# These are used to generate llm_analysis and suggestion in the selected language.

TRANSLATIONS = {
    "en": {
        # Basic suggestions
        "suggestion_low": "✅ O-RADS score < 3 suggests low risk. Routine monitoring is sufficient.",
        "suggestion_high": "⚠️ O-RADS score ≥ 3 indicates suspicious findings. Recommend specialist consultation.",
        
        # Detailed analysis templates for different risk levels
        "reasoning_low": "The lesion is {size_mm} mm, {cyst_type} type with only {solid_components_percentage}% solid components. The wall is {wall_irregularity} and vascularity is {vascularity}. No concerning septations. These are all benign features.",
        "reasoning_medium": "This lesion measures {size_mm} mm and is classified as {cyst_type}. Solid components are {solid_components_percentage}% and vascularity is {vascularity}. The wall is {wall_irregularity} with {septations}. These features place it in the indeterminate category (O-RADS 3), where malignancy risk is 0.5–5%.",
        "reasoning_high": "Critical findings: size {size_mm} mm, {cyst_type} cyst with {solid_components_percentage}% solid components. Vascularity is {vascularity}, and the wall is {wall_irregularity}. Septations: {septations}. These are highly suspicious features associated with O-RADS {orad_score} and malignancy risk >50% for O-RADS 5, 5-50% for O-RADS 4.",
        
        "meaning_low": "Low risk of malignancy (<0.5%). Routine monitoring is sufficient.",
        "meaning_medium": "Indeterminate lesion – cannot rule out early malignancy or borderline tumor. Requires further evaluation.",
        "meaning_high": "High likelihood of malignancy. Immediate oncologic workup is essential.",
        
        "steps_low": "• Continue routine annual screening\n• No immediate intervention\n• Re‑evaluate if pain or other symptoms develop",
        "steps_medium": "• Short-interval follow‑up ultrasound in 6‑8 weeks\n• Consider pelvic MRI with contrast\n• Discuss with a gynecologist for possible surveillance or biopsy",
        "steps_high": "• Urgent referral to a gynecologic oncologist\n• Perform contrast‑enhanced MRI or CT abdomen/pelvis\n• Consider ultrasound‑guided biopsy\n• Surgical staging (laparoscopy/laparotomy) likely needed"
    },
    "es": {
        "suggestion_low": "✅ La puntuación O-RADS < 3 sugiere bajo riesgo. El seguimiento de rutina es suficiente.",
        "suggestion_high": "⚠️ La puntuación O-RADS ≥ 3 indica hallazgos sospechosos. Recomiende consulta con especialista.",
        
        "reasoning_low": "La lesión mide {size_mm} mm, tipo {cyst_type} con solo {solid_components_percentage}% de componentes sólidos. La pared es {wall_irregularity} y la vascularidad es {vascularity}. Sin tabiques preocupantes. Todas estas son características benignas.",
        "reasoning_medium": "Esta lesión mide {size_mm} mm y se clasifica como {cyst_type}. Los componentes sólidos son {solid_components_percentage}% y la vascularidad es {vascularity}. La pared es {wall_irregularity} con {septations}. Estas características la ubican en la categoría indeterminada (O-RADS 3), donde el riesgo de malignidad es 0.5–5%.",
        "reasoning_high": "Hallazgos críticos: tamaño {size_mm} mm, quiste {cyst_type} con {solid_components_percentage}% de componentes sólidos. La vascularidad es {vascularity} y la pared es {wall_irregularity}. Tabiques: {septations}. Estas son características altamente sospechosas asociadas con O-RADS {orad_score} y riesgo de malignidad >50% para O-RADS 5, 5-50% para O-RADS 4.",
        
        "meaning_low": "Bajo riesgo de malignidad (<0.5%). El monitoreo de rutina es suficiente.",
        "meaning_medium": "Lesión indeterminada – no se puede descartar malignidad temprana o tumor borderline. Requiere evaluación adicional.",
        "meaning_high": "Alta probabilidad de malignidad. Es esencial un estudio oncológico inmediato.",
        
        "steps_low": "• Continúe con cribado anual de rutina\n• Sin intervención inmediata\n• Re‑evalúe si desarrolla dolor u otros síntomas",
        "steps_medium": "• Seguimiento por ultrasonido a corto plazo en 6‑8 semanas\n• Considere RMN pélvica con contraste\n• Discuta con un ginecólogo para posible vigilancia o biopsia",
        "steps_high": "• Derivación urgente a oncólogo ginecológico\n• Realice RMN o TC abdominopélvica mejorada con contraste\n• Considere biopsia guiada por ultrasonido\n• Estadificación quirúrgica (laparoscopia/laparotomía) probable"
    },
    "hi": {
        "suggestion_low": "✅ O-RADS स्कोर < 3 कम जोखिम का सुझाव देता है। नियमित निगरानी पर्याप्त है।",
        "suggestion_high": "⚠️ O-RADS स्कोर ≥ 3 संदिग्ध निष्कर्षों को इंगित करता है। विशेषज्ञ परामर्श की सिफारिश करें।",
        
        "reasoning_low": "यह घाव {size_mm} मिमी है, {cyst_type} प्रकार केवल {solid_components_percentage}% ठोस घटकों के साथ। दीवार {wall_irregularity} है और संवहनीयता {vascularity} है। कोई चिंताजनक隔walls नहीं। ये सभी सौम्य विशेषताएं हैं।",
        "reasoning_medium": "यह घाव {size_mm} मिमी मापता है और {cyst_type} के रूप में वर्गीकृत है। ठोस घटक {solid_components_percentage}% हैं और संवहनीयता {vascularity} है। दीवार {wall_irregularity} के साथ {septations} है। ये विशेषताएं इसे अनिर्णायक श्रेणी (O-RADS 3) में रखती हैं, जहां घातकता का जोखिम 0.5–5% है।",
        "reasoning_high": "महत्वपूर्ण निष्कर्ष: आकार {size_mm} मिमी, {cyst_type} पुटी {solid_components_percentage}% ठोस घटकों के साथ। संवहनीयता {vascularity} है, और दीवार {wall_irregularity} है।隔walls: {septations}। ये O-RADS {orad_score} से जुड़ी अत्यधिक संदिग्ध विशेषताएं हैं और O-RADS 5 के लिए घातकता का जोखिम >50%, O-RADS 4 के लिए 5-50% है।",
        
        "meaning_low": "घातकता का कम जोखिम (<0.5%)। नियमित निगरानी पर्याप्त है।",
        "meaning_medium": "अनिर्णायक घाव – प्रारंभिक घातकता या सीमावर्ती ट्यूमर को बाहर नहीं किया जा सकता। आगे मूल्यांकन की आवश्यकता है।",
        "meaning_high": "घातकता की उच्च संभावना। तुरंत ऑन्कोलॉजिकल कार्य आवश्यक है।",
        
        "steps_low": "• नियमित वार्षिक स्क्रीनिंग जारी रखें\n• कोई तत्काल हस्तक्षेप नहीं\n• यदि दर्द या अन्य लक्षण विकसित हों तो पुनः मूल्यांकन करें",
        "steps_medium": "• 6‑8 सप्ताह में अल्पकालीन अनुवर्ती अल्ट्रासाउंड\n• विपरीत के साथ पेल्विक एमआरआई पर विचार करें\n• संभावित निगरानी या बायोप्सी के लिए स्त्री रोग विशेषज्ञ के साथ चर्चा करें",
        "steps_high": "• स्त्री रोग ऑन्कोलॉजिस्ट को तत्काल रेफरल\n• विपरीत-वर्धित एमआरआई या सीटी पेट/पेल्विस करें\n• अल्ट्रासाउंड-निर्देशित बायोप्सी पर विचार करें\n• सर्जिकल स्टेजिंग (लैप्रोस्कोपी/लैपरोटॉमी) संभवतः आवश्यक"
    },
    "kn": {
        "suggestion_low": "✅ O-RADS ಸ್ಕೋರ್ < 3 ಕಡಿಮೆ ಅಪಾಯವನ್ನು ಸೂಚಿಸುತ್ತದೆ. ನಿಯಮಿತ ಮೇಲ್ವಿಚಾರಣೆ ಸಾಕು.",
        "suggestion_high": "⚠️ O-RADS ಸ್ಕೋರ್ ≥ 3 ಅನುಮಾನಾಸ್ಪದ ಸಂಶೋಧನೆಗಳನ್ನು ಸೂಚಿಸುತ್ತದೆ. ತಜ್ಞರ ಸಮಾಲೋಚನೆ ಶಿಫಾರಸು ಮಾಡಿ.",
        
        "reasoning_low": "ಈ ಸಂರಚನೆ {size_mm} ಮಿಮೀ, {cyst_type} ಪ್ರಕಾರ ಕೇವಲ {solid_components_percentage}% ಘನ ಘಟಕಗಳೊಂದಿಗೆ. ಗೋಡೆ {wall_irregularity} ಮತ್ತು ರಕ್ತವಹನವು {vascularity}. ಯಾವುದೇ ಕಾಳಜಿಗ್ರಸ್ತ ವಿಭಜನೆಗಳಿಲ್ಲ. ಇವೆಲ್ಲ ಸೌಮ್ಯ ವೈಶಿಷ್ಟ್ಯಗಳು.",
        "reasoning_medium": "ಈ ಸಂರಚನೆ {size_mm} ಮಿಮೀ ಅಳತೆ ಮತ್ತು {cyst_type} ಎಂದು ವರ್ಗೀಕರಿಸಲಾಗಿದೆ. ಘನ ಘಟಕಗಳು {solid_components_percentage}% ಮತ್ತು ರಕ್ತವಹನವು {vascularity}. ಗೋಡೆ {wall_irregularity} ತೊಂದರೆ {septations}. ಈ ವೈಶಿಷ್ಟ್ಯಗಳು ಅನಿರ್ದಿಷ್ಟ ವರ್ಗ (O-RADS 3) ಗೆ ಇದನ್ನು ಇರಿಸುತ್ತದೆ, ಇಲ್ಲಿ ಮಾರಕತೆ ಅಪಾಯ 0.5–5%.",
        "reasoning_high": "ನಿರ್ಣಾಯಕ ಸಂಶೋಧನೆಗಳು: ಗಾತ್ರ {size_mm} ಮಿಮೀ, {cyst_type} ಸಿಸ್ಟ {solid_components_percentage}% ಘನ ಘಟಕಗಳೊಂದಿಗೆ. ರಕ್ತವಹನವು {vascularity}, ಮತ್ತು ಗೋಡೆ {wall_irregularity}. ವಿಭಜನೆಗಳು: {septations}. ಇವುಗಳು O-RADS {orad_score} ಗೆ ಸಂಬಂಧಿಸಿದ ಅತ್ಯಂತ ಅನುಮಾನಾಸ್ಪದ ವೈಶಿಷ್ಟ್ಯಗಳು ಮತ್ತು O-RADS 5 ಗೆ >50% ಮಾರಕತೆ ಅಪಾಯ, O-RADS 4 ಗೆ 5-50%.",
        
        "meaning_low": "ಮಾರಕತೆಯ ಕಡಿಮೆ ಅಪಾಯ (<0.5%). ನಿಯಮಿತ ಮೇಲ್ವಿಚಾರಣೆ ಸಾಕು.",
        "meaning_medium": "ಅನಿರ್ದಿಷ್ಟ ಸಂರಚನೆ – ಆರಂಭಿಕ ಮಾರಕತೆ ಅಥವಾ ಗಡಿ ಗೆಡ್ಡೆಯನ್ನು ಅನ್ವೇಷಣೆ ಮಾಡುವುದು ಸಾಧ್ಯವಿಲ್ಲ. ಹೆಚ್ಚಿನ ಮೌಲ್ಯಮಾಪನದ ಅಗತ್ಯವಿದೆ.",
        "meaning_high": "ಮಾರಕತೆಯ ಹೆಚ್ಚಿನ ಸಂಭವನೀಯತೆ. ತುರ್ತು ಡಾಕ್ಟರ ವಿಷಯದ ಕೆಲಸ ಅಗತ್ಯವಿದೆ.",
        
        "steps_low": "• ನಿಯಮಿತ ವಾರ್ಷಿಕ ಸ್ಕ್ರೀನಿಂಗ್ ಮುಂದುವರಿಸಿ\n• ತಕ್ಷಣದ ಹಸ್ತಕ್ಷೇಪ ಇಲ್ಲ\n• ನೋವು ಅಥವಾ ಇತರ ರೋಗಲಕ್ಷಣಗಳು ಅಭಿವೃದ್ಧಿ ಆದರೆ ಮರು-ಮೌಲ್ಯಮಾಪನ ಮಾಡಿ",
        "steps_medium": "• 6‑8 ವಾರಗಳಲ್ಲಿ ಅಲ್ಪಾವಧಿಯ ಅನುವರ್ತನ ಅಲ್ಟ್ರಾಸೌಂಡ್\n• ವೈಪರೀತ್ಯ ಸಹಿತ ಪೆಲ್ವಿಕ್ ಎಮ್‌ಆರ್‌ಐ ಪರಿಗಣಿಸಿ\n• ಸಂಭವನೀಯ ವಿಗಿಲೆನ್ಸ್ ಅಥವಾ ಜೀವನ ಲಾಭ ಫೋರಮ್‍ನಿ ಗೈನಿಕೋಲಜಿಸ್ಟ್‌ನೊಂದಿಗೆ ಚರ್ಚೆ ಮಾಡಿ",
        "steps_high": "• ಗೈನಿಕೋಲಜಿಕ್ ಒಂಕೋಲಜಿಸ್ಟ್‌ಗೆ ತುರ್ತು ರೆಫರೆನ್ಸ್\n• ವೈಪರೀತ್ಯ-ವರ್ಧನೆಯ ಎಮ್‌ಆರ್‌ಐ ಅಥವಾ ಸಿಟಿ ಆಮ್ನೆ/ಪೆಲ್ವಿಸ್ ನಿರ್ವಹಿಸಿ\n• ಅಲ್ಟ್ರಾಸೌಂಡ್-ನಿರ್ದೇಶನೆಯ ಜೀವನ ಲಾಭ ಪರಿಗಣಿಸಿ\n• ಶಸ್ತ್ರಚಿಕಿತ್ಸಾ ಪರ್ಯಾಯ (ಲ್ಯಾಪ್ರೋಸ್ಕೋಪಿ/ಲ್ಯಾಪರೋಟಮಿ) ಬಹುಶಃ ಅಗತ್ಯ"
    }
}

def get_localized_text(lang, key, **kwargs):
    """Return translated and formatted text."""
    lang_dict = TRANSLATIONS.get(lang, TRANSLATIONS["en"])
    template = lang_dict.get(key, "")
    if kwargs:
        return template.format(**kwargs)
    else:
        return template

# ---------- Routes ----------
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/predict', methods=['POST'])
def predict():
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400
    file = request.files['file']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type'}), 400

    lang = request.form.get('language', 'en')
    if lang not in TRANSLATIONS:
        lang = 'en'

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
    file.save(filepath)

    try:
        # ---- Validate that the image is an ovarian ultrasound ----
        if not is_ovarian_ultrasound(filepath):
            if os.path.exists(filepath):
                os.remove(filepath)
            return jsonify({
                'error': 'The uploaded image does not appear to be an ovarian ultrasound. Please upload a valid ultrasound image of the ovary.'
            }), 400
        # --------------------------------------------------------
        
        result = predictor.predict_orad_score(filepath)
        orad = result['orad_score']
        confidence_val = result['confidence'] * 100
        clinical = result['clinical_features']
        brightness = result['features_used']['brightness']
        contrast = result['features_used']['contrast']

        # ---------- Detailed analysis generation ----------
        if orad <= 2:
            # Low risk
            reasoning = get_localized_text(
                lang, "reasoning_low",
                size_mm=clinical['size_mm'],
                cyst_type=clinical['cyst_type'],
                solid_components_percentage=clinical['solid_components_percentage'],
                wall_irregularity=clinical['wall_irregularity'],
                vascularity=clinical['vascularity']
            )
            meaning = get_localized_text(lang, "meaning_low")
            steps = get_localized_text(lang, "steps_low")
        elif orad == 3:
            # Indeterminate
            reasoning = get_localized_text(
                lang, "reasoning_medium",
                size_mm=clinical['size_mm'],
                cyst_type=clinical['cyst_type'],
                solid_components_percentage=clinical['solid_components_percentage'],
                vascularity=clinical['vascularity'],
                wall_irregularity=clinical['wall_irregularity'],
                septations=clinical['septations']
            )
            meaning = get_localized_text(lang, "meaning_medium")
            steps = get_localized_text(lang, "steps_medium")
        else:  # orad >= 4
            # Suspicious / high risk
            reasoning = get_localized_text(
                lang, "reasoning_high",
                size_mm=clinical['size_mm'],
                cyst_type=clinical['cyst_type'],
                solid_components_percentage=clinical['solid_components_percentage'],
                vascularity=clinical['vascularity'],
                wall_irregularity=clinical['wall_irregularity'],
                septations=clinical['septations'],
                orad_score=orad
            )
            meaning = get_localized_text(lang, "meaning_high")
            steps = get_localized_text(lang, "steps_high")

        # Build the final analysis text
        llm_analysis = f"""**Based on this ultrasound image analysis:**

**Image characteristics:** brightness {brightness:.1f}, contrast {contrast:.1f}

**Clinical findings:** {clinical['size_mm']} mm {clinical['cyst_type']} cyst with {clinical['solid_components_percentage']}% solid components, {clinical['vascularity']} vascularity, {clinical['septations']}, and {clinical['wall_irregularity']} wall.

**Why O-RADS {orad}?**  
{reasoning}

**What does this mean?**  
{meaning}

**Recommended next steps:**  
{steps}

**Confidence in this assessment:** {confidence_val:.1f}% based on image quality and feature detection.
"""
        # End of detailed analysis

        suggestion = get_localized_text(lang, "suggestion_low") if orad < 3 else get_localized_text(lang, "suggestion_high")
        danger_flag = orad >= 3

        response_data = {
            'orad_score': orad,
            'confidence': round(confidence_val, 2),
            'class_probabilities': result['class_probabilities'],
            'danger_flag': danger_flag,
            'suggestion': suggestion,
            'llm_analysis': llm_analysis,
            'clinical_features': clinical,
            'image_features': result['features_used'],
            'timestamp': datetime.now().isoformat(),
            'id': len(analysis_history) + 1
        }

        analysis_history.append(response_data)
        return jsonify(response_data)

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        if os.path.exists(filepath):
            os.remove(filepath)

@app.route('/history', methods=['GET'])

def history():
    return jsonify(analysis_history)

@app.route('/chat', methods=['POST'])
def chat():
    data = request.get_json()
    user_message = data.get('message', '').strip()
    history = data.get('history', [])
    if not user_message:
        return jsonify({'error': 'Empty message'}), 400

    # Use the most recent analysis as context (if any)
    context = ""
    if analysis_history:
        last = analysis_history[-1]
        context = f"Latest analysis: O-RADS {last['orad_score']} (confidence {last['confidence']}%). Clinical features: {last['clinical_features']}. Suggestion: {last['suggestion']}. "

    system_prompt = f"You are a medical assistant. {context}Answer the user's question concisely and helpfully. Do not give diagnoses. Suggest consulting a doctor when needed."

    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    try:
        response = client.chat.completions.create(
            model=CHAT_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=500
        )
        answer = response.choices[0].message.content.strip()
        return jsonify({'answer': answer})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    import os
    port = int(os.environ.get("PORT", 5000))
    app.run(debug=False, host='0.0.0.0', port=port)
