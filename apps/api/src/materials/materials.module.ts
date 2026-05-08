import { Module } from "@nestjs/common";
import { MaterialsService } from "./materials.service";
import { MaterialsController } from "./materials.controller";
import { IphoneMetadataService } from "./iphone-metadata.service";
import { StorageModule } from "../storage/storage.module";

@Module({
  imports: [StorageModule],
  providers: [MaterialsService, IphoneMetadataService],
  controllers: [MaterialsController],
  exports: [MaterialsService],
})
export class MaterialsModule {}
