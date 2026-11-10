// Public settings for this app (none of these are secrets – they only work from this website).
window.RR_CONFIG = {
  // Google sign-in (saving videos to each person's own Google Drive)
  clientId: '358032782648-ens36eqm2bq33hqh19ef09jp3d24ivo9.apps.googleusercontent.com',
  // Lets phones in a room play each other's clips (restricted to Google Drive + this website)
  driveApiKey: 'AIzaSyDhkmsQVL5Q6-XDoa1jYy_b0OyYk8FyARI',
  // Rooms database (Firebase / Firestore, free plan)
  firebase: {
    apiKey: 'AIzaSyCv7uj-xt1p5dWuynAGbp91ZsOSmTO0gCM',
    authDomain: 'rally-reel.firebaseapp.com',
    projectId: 'rally-reel',
    storageBucket: 'rally-reel.firebasestorage.app',
    messagingSenderId: '358032782648',
    appId: '1:358032782648:web:4b2ab6a79dbbdaa13bfdcd',
  },
};
