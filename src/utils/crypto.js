const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

// Cifra un texto y devuelve iv:authTag:contenidoCifrado
function encrypt(text) {
  if (!text) return null;
  if (KEY.length !== 32) throw new Error('ENCRYPTION_KEY inválida (debe ser 32 bytes en hex)');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

// Descifra el formato iv:authTag:contenidoCifrado
function decrypt(encryptedText) {
  if (!encryptedText) return null;
  // Si no tiene el formato cifrado (texto plano viejo), devolverlo tal cual
  if (!encryptedText.includes(':')) return encryptedText;
  try {
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Error al descifrar:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt };