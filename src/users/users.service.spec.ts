import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

describe('UsersService', () => {
  let service: UsersService;
  let prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    prisma = {
      user: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(UsersService);
  });

  it('findByEmail delegates to prisma', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: '1' });
    await expect(service.findByEmail('a@b.c')).resolves.toEqual({ id: '1' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'a@b.c' },
    });
  });

  it('findById delegates to prisma', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: '1' });
    await expect(service.findById('1')).resolves.toEqual({ id: '1' });
  });

  it('create persists user', async () => {
    prisma.user.create.mockResolvedValue({ id: '1', email: 'a@b.c' });
    await expect(service.create('a@b.c', 'hash')).resolves.toMatchObject({
      email: 'a@b.c',
    });
  });

  it('markEmailVerified updates timestamp', async () => {
    prisma.user.update.mockResolvedValue({
      id: '1',
      emailVerifiedAt: new Date(),
    });
    await service.markEmailVerified('1');
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: '1' } }),
    );
  });

  it('updatePassword updates hash', async () => {
    prisma.user.update.mockResolvedValue({ id: '1' });
    await service.updatePassword('1', 'new-hash');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: '1' },
      data: { passwordHash: 'new-hash' },
    });
  });
});
