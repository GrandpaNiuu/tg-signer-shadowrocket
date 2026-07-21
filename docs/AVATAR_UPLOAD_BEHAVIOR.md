# Avatar upload behavior

Personal avatars are available to every signed-in user. Platform branding remains an administrator-only setting.

The avatar picker now behaves as a user-controlled photo editor:

- the picker opens the phone photo library through `image/*`;
- common browser-decodable formats are accepted, including JPEG, PNG, WebP, GIF, BMP and AVIF;
- HEIC/HEIF is accepted when the current browser can decode it;
- the selected photo opens in a manual crop screen;
- users can drag the image, change zoom and reset the position before confirming;
- the original photo is never uploaded or retained;
- only the confirmed, compressed avatar is saved.

Unsupported HEIC/HEIF files must be saved as JPEG or uploaded as a screenshot because browser image codec support varies by device.
