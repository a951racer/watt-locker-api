/**
 * Unit tests for GoogleDriveAdapter.
 * Uses mocked Google Drive API calls to test all FileStorageAdapter operations.
 */

import { GoogleDriveAdapter, GoogleDriveAdapterConfig } from './googleDriveAdapter';
import { google } from 'googleapis';

// Mock the googleapis module
jest.mock('googleapis', () => {
  const mockFilesCreate = jest.fn();
  const mockFilesGet = jest.fn();
  const mockFilesDelete = jest.fn();
  const mockFilesList = jest.fn();

  const mockDrive = {
    files: {
      create: mockFilesCreate,
      get: mockFilesGet,
      delete: mockFilesDelete,
      list: mockFilesList,
    },
  };

  const mockSetCredentials = jest.fn();
  const mockOn = jest.fn();

  const MockOAuth2 = jest.fn().mockImplementation(() => ({
    setCredentials: mockSetCredentials,
    on: mockOn,
    credentials: {
      refresh_token: 'mock-refresh-token',
    },
  }));

  return {
    google: {
      auth: {
        OAuth2: MockOAuth2,
      },
      drive: jest.fn().mockReturnValue(mockDrive),
    },
  };
});

function getMockDrive() {
  return (google.drive as jest.Mock).mock.results[0]?.value ?? google.drive({ version: 'v3' });
}

function getMockOAuth2Instance() {
  const OAuth2 = google.auth.OAuth2 as unknown as jest.Mock;
  // Return the most recent instance
  const calls = OAuth2.mock.results;
  return calls[calls.length - 1]?.value;
}

describe('GoogleDriveAdapter', () => {
  let adapter: GoogleDriveAdapter;
  let mockDrive: {
    files: {
      create: jest.Mock;
      get: jest.Mock;
      delete: jest.Mock;
      list: jest.Mock;
    };
  };

  const defaultConfig: GoogleDriveAdapterConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    redirectUri: 'http://localhost:3000/callback',
    tokens: {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiryDate: Date.now() + 3600000,
    },
    basePath: 'WattLocker',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockDrive = getMockDrive();
    adapter = new GoogleDriveAdapter(defaultConfig);
  });

  describe('constructor', () => {
    it('should initialize OAuth2 client with provided credentials', () => {
      expect(google.auth.OAuth2).toHaveBeenCalledWith(
        'test-client-id',
        'test-client-secret',
        'http://localhost:3000/callback',
      );
    });

    it('should set credentials on the OAuth2 client', () => {
      const oauth2 = getMockOAuth2Instance();
      expect(oauth2.setCredentials).toHaveBeenCalledWith({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expiry_date: expect.any(Number),
      });
    });

    it('should register a token refresh listener', () => {
      const oauth2 = getMockOAuth2Instance();
      expect(oauth2.on).toHaveBeenCalledWith('tokens', expect.any(Function));
    });
  });

  describe('store', () => {
    const fileBuffer = Buffer.from('workout data');
    const metadata = {
      fileName: '2024-03-15_morning-ride.fit',
      mimeType: 'application/octet-stream',
      workoutDate: new Date('2024-03-15T08:00:00Z'),
      dataSource: 'manual',
    };

    it('should upload file to the correct year/month folder', async () => {
      // Mock folder resolution: WattLocker -> 2024 -> 03 (all exist)
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'wattlocker-folder-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'year-folder-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'month-folder-id' }] } });

      mockDrive.files.create.mockResolvedValueOnce({
        data: {
          id: 'new-file-id',
          name: '2024-03-15_morning-ride.fit',
          webViewLink: 'https://drive.google.com/file/d/new-file-id/view',
        },
      });

      const result = await adapter.store(fileBuffer, metadata);

      expect(result).toEqual({
        fileId: 'new-file-id',
        fileName: '2024-03-15_morning-ride.fit',
        folderPath: 'WattLocker/2024/03',
        webViewLink: 'https://drive.google.com/file/d/new-file-id/view',
      });
    });

    it('should create folders if they do not exist', async () => {
      // Simulate no existing folders
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [] } }) // WattLocker not found
        .mockResolvedValueOnce({ data: { files: [] } }) // 2024 not found
        .mockResolvedValueOnce({ data: { files: [] } }); // 03 not found

      mockDrive.files.create
        .mockResolvedValueOnce({ data: { id: 'new-wattlocker-id' } }) // Create WattLocker
        .mockResolvedValueOnce({ data: { id: 'new-year-id' } }) // Create 2024
        .mockResolvedValueOnce({ data: { id: 'new-month-id' } }) // Create 03
        .mockResolvedValueOnce({
          data: {
            id: 'uploaded-file-id',
            name: '2024-03-15_morning-ride.fit',
            webViewLink: null,
          },
        });

      const result = await adapter.store(fileBuffer, metadata);

      expect(result.fileId).toBe('uploaded-file-id');
      expect(result.folderPath).toBe('WattLocker/2024/03');
      // 3 folder creations + 1 file upload
      expect(mockDrive.files.create).toHaveBeenCalledTimes(4);
    });

    it('should derive correct folder path for January workout', async () => {
      const januaryMetadata = {
        ...metadata,
        workoutDate: new Date('2023-01-05T10:00:00Z'),
      };

      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'base-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'year-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'month-id' }] } });

      mockDrive.files.create.mockResolvedValueOnce({
        data: { id: 'file-id', name: 'test.fit', webViewLink: null },
      });

      const result = await adapter.store(fileBuffer, januaryMetadata);

      expect(result.folderPath).toBe('WattLocker/2023/01');
    });

    it('should derive correct folder path for December workout', async () => {
      const decemberMetadata = {
        ...metadata,
        workoutDate: new Date('2024-12-25T14:00:00Z'),
      };

      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'base-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'year-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'month-id' }] } });

      mockDrive.files.create.mockResolvedValueOnce({
        data: { id: 'file-id', name: 'test.fit', webViewLink: null },
      });

      const result = await adapter.store(fileBuffer, decemberMetadata);

      expect(result.folderPath).toBe('WattLocker/2024/12');
    });

    it('should pass correct metadata to Drive API file creation', async () => {
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'base-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'year-id' }] } })
        .mockResolvedValueOnce({ data: { files: [{ id: 'month-id' }] } });

      mockDrive.files.create.mockResolvedValueOnce({
        data: { id: 'file-id', name: metadata.fileName, webViewLink: null },
      });

      await adapter.store(fileBuffer, metadata);

      // The last create call is the file upload (not folder creation)
      const lastCall = mockDrive.files.create.mock.calls[0][0];
      expect(lastCall.requestBody).toEqual({
        name: '2024-03-15_morning-ride.fit',
        mimeType: 'application/octet-stream',
        parents: ['month-id'],
      });
      expect(lastCall.media.mimeType).toBe('application/octet-stream');
      expect(lastCall.fields).toBe('id,name,webViewLink');
    });
  });

  describe('retrieve', () => {
    it('should download file content by file ID', async () => {
      const fileContent = Buffer.from('binary workout data');
      mockDrive.files.get.mockResolvedValueOnce({
        data: fileContent.buffer.slice(
          fileContent.byteOffset,
          fileContent.byteOffset + fileContent.byteLength,
        ),
      });

      const reference = {
        fileId: 'existing-file-id',
        fileName: 'workout.fit',
        folderPath: 'WattLocker/2024/03',
      };

      const result = await adapter.retrieve(reference);

      expect(mockDrive.files.get).toHaveBeenCalledWith(
        { fileId: 'existing-file-id', alt: 'media' },
        { responseType: 'arraybuffer' },
      );
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  describe('delete', () => {
    it('should delete file from Drive by file ID', async () => {
      mockDrive.files.delete.mockResolvedValueOnce({});

      const reference = {
        fileId: 'file-to-delete',
        fileName: 'old-workout.fit',
        folderPath: 'WattLocker/2024/01',
      };

      await adapter.delete(reference);

      expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'file-to-delete' });
    });
  });

  describe('listFiles', () => {
    it('should list files in a given folder path', async () => {
      // Mock folder resolution: WattLocker -> Inbox
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'base-id' }] } }) // WattLocker
        .mockResolvedValueOnce({ data: { files: [{ id: 'inbox-id' }] } }) // Inbox
        .mockResolvedValueOnce({
          data: {
            files: [
              {
                id: 'file-1',
                name: 'workout1.fit',
                webViewLink: 'https://drive.google.com/file/d/file-1/view',
              },
              { id: 'file-2', name: 'workout2.tcx', webViewLink: null },
            ],
            nextPageToken: null,
          },
        });

      const result = await adapter.listFiles('WattLocker/Inbox');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        fileId: 'file-1',
        fileName: 'workout1.fit',
        folderPath: 'WattLocker/Inbox',
        webViewLink: 'https://drive.google.com/file/d/file-1/view',
      });
      expect(result[1]).toEqual({
        fileId: 'file-2',
        fileName: 'workout2.tcx',
        folderPath: 'WattLocker/Inbox',
        webViewLink: undefined,
      });
    });

    it('should return empty array if folder does not exist', async () => {
      // First folder in path not found
      mockDrive.files.list.mockResolvedValueOnce({ data: { files: [] } });

      const result = await adapter.listFiles('NonExistent/Path');

      expect(result).toEqual([]);
    });

    it('should handle pagination when listing files', async () => {
      // Mock folder resolution (single folder path)
      mockDrive.files.list
        .mockResolvedValueOnce({ data: { files: [{ id: 'folder-id' }] } }) // Inbox folder
        .mockResolvedValueOnce({
          data: {
            files: [{ id: 'file-1', name: 'a.fit', webViewLink: null }],
            nextPageToken: 'page-2-token',
          },
        })
        .mockResolvedValueOnce({
          data: {
            files: [{ id: 'file-2', name: 'b.fit', webViewLink: null }],
            nextPageToken: null,
          },
        });

      const result = await adapter.listFiles('Inbox');

      expect(result).toHaveLength(2);
      expect(result[0].fileId).toBe('file-1');
      expect(result[1].fileId).toBe('file-2');
    });
  });

  describe('removeFromFolder', () => {
    it('should delete the file from Drive', async () => {
      mockDrive.files.delete.mockResolvedValueOnce({});

      const reference = {
        fileId: 'inbox-file-id',
        fileName: 'processed.fit',
        folderPath: 'WattLocker/Inbox',
      };

      await adapter.removeFromFolder(reference);

      expect(mockDrive.files.delete).toHaveBeenCalledWith({ fileId: 'inbox-file-id' });
    });
  });

  describe('token refresh', () => {
    it('should invoke onTokenRefresh callback when tokens are refreshed', () => {
      jest.clearAllMocks();

      const onTokenRefresh = jest.fn().mockResolvedValue(undefined);
      const configWithCallback: GoogleDriveAdapterConfig = {
        ...defaultConfig,
        onTokenRefresh,
      };

      new GoogleDriveAdapter(configWithCallback);

      // Get the token listener registered on the OAuth2 instance created for this adapter
      const oauth2 = getMockOAuth2Instance();
      const tokenCalls = oauth2.on.mock.calls.filter(
        (call: [string, unknown]) => call[0] === 'tokens',
      );
      // Use the last registered handler (from the adapter we just created)
      const tokenHandler = tokenCalls[tokenCalls.length - 1][1] as (
        tokens: Record<string, unknown>,
      ) => void;

      tokenHandler({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expiry_date: 9999999999,
      });

      expect(onTokenRefresh).toHaveBeenCalledWith({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiryDate: 9999999999,
      });
    });

    it('should not fail if no onTokenRefresh callback is provided', () => {
      jest.clearAllMocks();

      const configWithoutCallback: GoogleDriveAdapterConfig = {
        ...defaultConfig,
        onTokenRefresh: undefined,
      };

      new GoogleDriveAdapter(configWithoutCallback);

      const oauth2 = getMockOAuth2Instance();
      const tokenCalls = oauth2.on.mock.calls.filter(
        (call: [string, unknown]) => call[0] === 'tokens',
      );
      const tokenHandler = tokenCalls[tokenCalls.length - 1][1] as (
        tokens: Record<string, unknown>,
      ) => void;

      // Should not throw
      expect(() =>
        tokenHandler({
          access_token: 'new-token',
          refresh_token: null,
          expiry_date: null,
        }),
      ).not.toThrow();
    });

    it('should use existing refresh token if new one is not provided', () => {
      jest.clearAllMocks();

      const onTokenRefresh = jest.fn().mockResolvedValue(undefined);
      const configWithCallback: GoogleDriveAdapterConfig = {
        ...defaultConfig,
        onTokenRefresh,
      };

      new GoogleDriveAdapter(configWithCallback);

      const oauth2 = getMockOAuth2Instance();
      const tokenCalls = oauth2.on.mock.calls.filter(
        (call: [string, unknown]) => call[0] === 'tokens',
      );
      const tokenHandler = tokenCalls[tokenCalls.length - 1][1] as (
        tokens: Record<string, unknown>,
      ) => void;

      tokenHandler({
        access_token: 'refreshed-access-token',
        refresh_token: null,
        expiry_date: null,
      });

      expect(onTokenRefresh).toHaveBeenCalledWith({
        accessToken: 'refreshed-access-token',
        refreshToken: 'mock-refresh-token', // Falls back to credentials
        expiryDate: undefined,
      });
    });
  });
});
