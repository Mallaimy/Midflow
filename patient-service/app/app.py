import os
import logging
import re
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_marshmallow import Marshmallow
from datetime import datetime
import uuid

# HIPAA: structured logging, no PHI in logs
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(levelname)s %(name)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# HIPAA: database connection over SSL enforced
DATABASE_URL = os.environ.get('DATABASE_URL')
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable not set")

app.config['SQLALCHEMY_DATABASE_URI'] = DATABASE_URL
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    "connect_args": {"sslmode": "require"}
}
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
ma = Marshmallow(app)

# ── Model ──────────────────────────────────────────────────────────────────
class Patient(db.Model):
    __tablename__ = 'patients'

    id             = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    first_name     = db.Column(db.String(100), nullable=False)
    last_name      = db.Column(db.String(100), nullable=False)
    date_of_birth  = db.Column(db.Date, nullable=False)
    email          = db.Column(db.String(255), unique=True, nullable=False)
    phone          = db.Column(db.String(20), nullable=False)
    blood_type     = db.Column(db.String(5))
    created_at     = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at     = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def __repr__(self):
        # HIPAA: never log full patient object with PHI
        return f"<Patient id={self.id}>"

# ── Schema ─────────────────────────────────────────────────────────────────
class PatientSchema(ma.SQLAlchemyAutoSchema):
    class Meta:
        model   = Patient
        load_instance = True
        exclude = ()

patient_schema  = PatientSchema()
patients_schema = PatientSchema(many=True)

# ── Helpers ────────────────────────────────────────────────────────────────
def validate_email(email: str) -> bool:
    return bool(re.match(r'^[\w\.-]+@[\w\.-]+\.\w+$', email))

def validate_phone(phone: str) -> bool:
    return bool(re.match(r'^\+?[\d\s\-\(\)]{7,20}$', phone))

def mask_email(email: str) -> str:
    """HIPAA: mask PHI before logging."""
    parts = email.split('@')
    return f"{parts[0][:2]}***@{parts[1]}" if len(parts) == 2 else "***"

# ── Routes ─────────────────────────────────────────────────────────────────
@app.route('/health', methods=['GET'])
def health():
    try:
        db.session.execute(db.text('SELECT 1'))
        return jsonify({
            "status":  "healthy",
            "service": "patient-service",
            "version": "1.0.0"
        }), 200
    except Exception:
        logger.error("Health check failed - database unreachable")
        return jsonify({"status": "unhealthy", "service": "patient-service"}), 503

@app.route('/patients', methods=['GET'])
def get_patients():
    try:
        page     = request.args.get('page', 1, type=int)
        per_page = min(request.args.get('per_page', 20, type=int), 100)
        paginated = Patient.query.order_by(Patient.created_at.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )
        logger.info(f"Patient list retrieved - count={paginated.total}")
        return jsonify({
            "patients":    patients_schema.dump(paginated.items),
            "total":       paginated.total,
            "page":        page,
            "per_page":    per_page,
            "total_pages": paginated.pages
        }), 200
    except Exception as e:
        logger.error("Failed to retrieve patient list")
        return jsonify({"error": "Failed to retrieve patients"}), 500

@app.route('/patients', methods=['POST'])
def create_patient():
    try:
        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body required"}), 400

        required = ['first_name', 'last_name', 'date_of_birth', 'email', 'phone']
        missing  = [f for f in required if not data.get(f)]
        if missing:
            return jsonify({"error": f"Missing fields: {', '.join(missing)}"}), 400

        if not validate_email(data['email']):
            return jsonify({"error": "Invalid email format"}), 400
        if not validate_phone(data['phone']):
            return jsonify({"error": "Invalid phone format"}), 400

        existing = Patient.query.filter_by(email=data['email']).first()
        if existing:
            return jsonify({"error": "Patient with this email already exists"}), 409

        patient = Patient(
            first_name    = data['first_name'].strip(),
            last_name     = data['last_name'].strip(),
            date_of_birth = datetime.strptime(data['date_of_birth'], '%Y-%m-%d').date(),
            email         = data['email'].strip().lower(),
            phone         = data['phone'].strip(),
            blood_type    = data.get('blood_type', '').strip() or None
        )
        db.session.add(patient)
        db.session.commit()

        # HIPAA: log action with masked PHI only
        logger.info(f"Patient created - id={patient.id} email={mask_email(patient.email)}")
        return jsonify(patient_schema.dump(patient)), 201

    except ValueError as e:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400
    except Exception:
        db.session.rollback()
        logger.error("Failed to create patient")
        return jsonify({"error": "Failed to create patient"}), 500

@app.route('/patients/<patient_id>', methods=['GET'])
def get_patient(patient_id):
    try:
        patient = Patient.query.get(patient_id)
        if not patient:
            return jsonify({"error": "Patient not found"}), 404
        logger.info(f"Patient record accessed - id={patient_id}")
        return jsonify(patient_schema.dump(patient)), 200
    except Exception:
        logger.error(f"Failed to retrieve patient - id={patient_id}")
        return jsonify({"error": "Failed to retrieve patient"}), 500

@app.route('/patients/<patient_id>', methods=['PUT'])
def update_patient(patient_id):
    try:
        patient = Patient.query.get(patient_id)
        if not patient:
            return jsonify({"error": "Patient not found"}), 404

        data = request.get_json()
        if not data:
            return jsonify({"error": "Request body required"}), 400

        if 'email' in data:
            if not validate_email(data['email']):
                return jsonify({"error": "Invalid email format"}), 400
            existing = Patient.query.filter(
                Patient.email == data['email'].lower(),
                Patient.id    != patient_id
            ).first()
            if existing:
                return jsonify({"error": "Email already in use"}), 409
            patient.email = data['email'].strip().lower()

        if 'phone' in data:
            if not validate_phone(data['phone']):
                return jsonify({"error": "Invalid phone format"}), 400
            patient.phone = data['phone'].strip()

        updatable = ['first_name', 'last_name', 'blood_type']
        for field in updatable:
            if field in data:
                setattr(patient, field, data[field].strip())

        if 'date_of_birth' in data:
            patient.date_of_birth = datetime.strptime(data['date_of_birth'], '%Y-%m-%d').date()

        patient.updated_at = datetime.utcnow()
        db.session.commit()

        logger.info(f"Patient updated - id={patient_id}")
        return jsonify(patient_schema.dump(patient)), 200

    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400
    except Exception:
        db.session.rollback()
        logger.error(f"Failed to update patient - id={patient_id}")
        return jsonify({"error": "Failed to update patient"}), 500

# ── Startup ────────────────────────────────────────────────────────────────
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)