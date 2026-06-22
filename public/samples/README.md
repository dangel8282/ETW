# Sample Images

이 폴더에 두는 이미지는 빌드 시 `dist/samples/` 로 복사되어 GitHub Pages 에 함께 배포됩니다.
앱의 "or load samples" 버튼이 이 폴더의 이미지를 fetch 해서 로드합니다.

## 사용법

1. 이 폴더에 샘플 이미지 파일들 추가 (BMP/PNG/JPG/TIF)
2. `manifest.json` 의 `images` 배열에 파일명 등록
3. `git commit && git push` → 자동 배포

## 주의

이 폴더의 파일들은 **public**입니다 (repo가 public이라 누구나 볼 수 있음).
민감한 측정 이미지는 두지 마세요.
