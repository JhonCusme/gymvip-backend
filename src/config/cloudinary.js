const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloudinary_url: process.env.CLOUDINARY_URL
});

// Storage para logos de gimnasios
const gymLogoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'gymvip/logos',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'svg'],
    transformation: [{ width: 400, height: 400, crop: 'fit' }]
  }
});

// Storage para fotos de instructores
const instructorPhotoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'gymvip/instructors',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face' }]
  }
});

const limits = { fileSize: 2 * 1024 * 1024 }; // 2MB máximo

const uploadGymLogo = multer({ 
  storage: gymLogoStorage, 
  limits,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'), false);
    }
    cb(null, true);
  }
});

const uploadInstructorPhoto = multer({ 
  storage: instructorPhotoStorage, 
  limits,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Solo se permiten imágenes'), false);
    }
    cb(null, true);
  }
});

// Subir firma (base64) directamente a Cloudinary
const uploadSignature = async (base64Data, userId) => {
  const result = await cloudinary.uploader.upload(base64Data, {
    folder: 'gymvip/signatures',
    public_id: `signature_${userId}_${Date.now()}`,
    resource_type: 'image'
  });
  return result.secure_url;
};

module.exports = { cloudinary, uploadGymLogo, uploadInstructorPhoto, uploadSignature };