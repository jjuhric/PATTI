const fs = require('fs');
const path = require('path');

const mockSearchAndDownloadImage = jest.fn();
jest.mock('../utils/wikimedia_images', () => ({
  searchAndDownloadImage: (...args) => mockSearchAndDownloadImage(...args)
}));

const mockToFile = jest.fn(async () => ({}));
const mockTrim = jest.fn(function trim() { return this; });
const mockResize = jest.fn(function resize() { return this; });
const mockExtract = jest.fn(function extract() { return this; });
const mockRotate = jest.fn(function rotate() { return this; });
const mockGrayscale = jest.fn(function grayscale() { return this; });
const mockModulate = jest.fn(function modulate() { return this; });
const mockFlip = jest.fn(function flip() { return this; });
const mockFlop = jest.fn(function flop() { return this; });
const mockToFormat = jest.fn(function toFormat() { return this; });
const mockComposite = jest.fn(function composite() { return this; });
const mockSharpInstance = {
  trim: mockTrim, resize: mockResize, extract: mockExtract, rotate: mockRotate,
  grayscale: mockGrayscale, modulate: mockModulate, flip: mockFlip, flop: mockFlop,
  toFormat: mockToFormat, composite: mockComposite, toFile: mockToFile
};
const mockSharpFactory = jest.fn(() => mockSharpInstance);
jest.mock('sharp', () => (...args) => mockSharpFactory(...args));

const { handleImageTool } = require('../tools/image_tool');

describe('handleImageTool', () => {
  const testRoot = path.join(process.cwd(), 'test_image_tool');
  let testImagePath;

  beforeAll(() => {
    fs.mkdirSync(testRoot, { recursive: true });
    testImagePath = path.join(testRoot, 'source.png');
    fs.writeFileSync(testImagePath, 'fake-png-bytes');
  });

  afterAll(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    mockSearchAndDownloadImage.mockReset();
    mockToFile.mockClear();
    mockTrim.mockClear();
    mockResize.mockClear();
    mockExtract.mockClear();
    mockRotate.mockClear();
    mockGrayscale.mockClear();
    mockModulate.mockClear();
    mockFlip.mockClear();
    mockFlop.mockClear();
    mockToFormat.mockClear();
    mockComposite.mockClear();
    mockSharpFactory.mockClear();
  });

  test('returns an error string for an unknown action', async () => {
    const output = await handleImageTool('bogus_action', {});
    expect(output).toMatch(/^Error: Unknown Image Tool action/);
  });

  describe('search_image', () => {
    test('requires query', async () => {
      const output = await handleImageTool('search_image', { destDir: testRoot });
      expect(output).toMatch(/^Error: "query"/);
    });

    test('requires destDir', async () => {
      const output = await handleImageTool('search_image', { query: 'board game' });
      expect(output).toMatch(/^Error: "destDir"/);
    });

    test('reports when no usable image is found', async () => {
      mockSearchAndDownloadImage.mockResolvedValue(null);
      const output = await handleImageTool('search_image', { query: 'nonexistent thing xyz', destDir: testRoot });
      expect(output).toMatch(/No usable free\/licensed image found/);
    });

    test('downloads an image and reports its path, license, and attribution', async () => {
      const downloadedPath = path.join(testRoot, 'abc.jpg');
      mockSearchAndDownloadImage.mockResolvedValue({
        path: downloadedPath,
        license: 'CC BY-SA 4.0',
        attribution: 'Some Artist, CC BY-SA 4.0, via Wikimedia Commons',
        sourceUrl: 'https://commons.wikimedia.org/wiki/File:abc.jpg'
      });

      const output = await handleImageTool('search_image', { query: 'monopoly board', destDir: testRoot });
      expect(mockSearchAndDownloadImage).toHaveBeenCalledWith('monopoly board', testRoot);
      expect(output).toContain(downloadedPath);
      expect(output).toContain('CC BY-SA 4.0');
      expect(output).toContain('Some Artist');
    });
  });

  describe('process_image', () => {
    test('requires imagePath', async () => {
      const output = await handleImageTool('process_image', { mode: 'trim' });
      expect(output).toMatch(/^Error: "imagePath"/);
    });

    test('rejects an invalid mode', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'invert' });
      expect(output).toMatch(/^Error: "mode"/);
    });

    test('errors when the image file does not exist', async () => {
      const output = await handleImageTool('process_image', { imagePath: path.join(testRoot, 'missing.png'), mode: 'trim' });
      expect(output).toMatch(/^Error: Image not found/);
    });

    test('trim mode calls sharp().trim().toFile() and writes to a derived output path', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'trim' });
      expect(mockSharpFactory).toHaveBeenCalledWith(testImagePath);
      expect(mockTrim).toHaveBeenCalled();
      expect(mockToFile).toHaveBeenCalledWith(path.join(testRoot, 'source_trim.png'));
      expect(output).toContain('source_trim.png');
    });

    test('resize mode requires width or height', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'resize' });
      expect(output).toMatch(/^Error: "resize" mode requires/);
    });

    test('resize mode calls sharp().resize().toFile()', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'resize', width: '200' });
      expect(mockResize).toHaveBeenCalledWith(200, null, { fit: 'inside' });
      expect(output).toContain('source_resize.png');
    });

    test('crop mode requires numeric left/top/width/height', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'crop', left: '0', top: '0' });
      expect(output).toMatch(/^Error: "crop" mode requires/);
    });

    test('crop mode calls sharp().extract().toFile()', async () => {
      const output = await handleImageTool('process_image', {
        imagePath: testImagePath, mode: 'crop', left: '10', top: '20', width: '100', height: '50'
      });
      expect(mockExtract).toHaveBeenCalledWith({ left: 10, top: 20, width: 100, height: 50 });
      expect(output).toContain('source_crop.png');
    });

    test('rejects an explicit outputPath equal to imagePath', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'trim', outputPath: testImagePath });
      expect(output).toMatch(/^Error: outputPath must differ/);
    });

    test('honors an explicit outputPath', async () => {
      const outPath = path.join(testRoot, 'custom_out.png');
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'trim', outputPath: outPath });
      expect(mockToFile).toHaveBeenCalledWith(outPath);
      expect(output).toContain(outPath);
    });

    test('rotate mode requires a numeric angle', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'rotate' });
      expect(output).toMatch(/^Error: "rotate" mode requires/);
    });

    test('rotate mode calls sharp().rotate(angle).toFile()', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'rotate', angle: '90' });
      expect(mockRotate).toHaveBeenCalledWith(90);
      expect(output).toContain('source_rotate.png');
    });

    test('grayscale mode calls sharp().grayscale().toFile()', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'grayscale' });
      expect(mockGrayscale).toHaveBeenCalled();
      expect(output).toContain('source_grayscale.png');
    });

    test('adjust mode requires at least one of brightness/saturation/hue', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'adjust' });
      expect(output).toMatch(/^Error: "adjust" mode requires/);
    });

    test('adjust mode calls sharp().modulate() with only the provided fields', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'adjust', brightness: '1.2', saturation: '0.8' });
      expect(mockModulate).toHaveBeenCalledWith({ brightness: 1.2, saturation: 0.8 });
      expect(output).toContain('source_adjust.png');
    });

    test('flip mode calls sharp().flip().toFile()', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'flip' });
      expect(mockFlip).toHaveBeenCalled();
      expect(mockFlop).not.toHaveBeenCalled();
      expect(output).toContain('source_flip.png');
    });

    test('flop mode calls sharp().flop().toFile()', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'flop' });
      expect(mockFlop).toHaveBeenCalled();
      expect(mockFlip).not.toHaveBeenCalled();
      expect(output).toContain('source_flop.png');
    });

    test('format mode requires a valid outputFormat', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'format', outputFormat: 'bmp' });
      expect(output).toMatch(/^Error: "format" mode requires/);
    });

    test('format mode calls sharp().toFormat() and derives the new extension', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'format', outputFormat: 'webp' });
      expect(mockToFormat).toHaveBeenCalledWith('webp');
      expect(output).toContain('source_format.webp');
    });

    test('watermark mode requires overlayPath', async () => {
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'watermark' });
      expect(output).toMatch(/^Error: "watermark" mode requires/);
    });

    test('watermark mode errors when the overlay file does not exist', async () => {
      const output = await handleImageTool('process_image', {
        imagePath: testImagePath, mode: 'watermark', overlayPath: path.join(testRoot, 'missing_overlay.png')
      });
      expect(output).toMatch(/^Error: Overlay image not found/);
    });

    test('watermark mode calls sharp().composite() with the overlay and default gravity', async () => {
      const overlayPath = path.join(testRoot, 'badge.png');
      fs.writeFileSync(overlayPath, 'fake-badge-bytes');
      const output = await handleImageTool('process_image', { imagePath: testImagePath, mode: 'watermark', overlayPath });
      expect(mockComposite).toHaveBeenCalledWith([{ input: overlayPath, gravity: 'southeast' }]);
      expect(output).toContain('source_watermark.png');
    });
  });
});
